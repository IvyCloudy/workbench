/**
 * deletedRowsStore 单元测试
 *
 * 聚焦 syncDeletedRows 对删除接口 type 分档的处理：
 *   type='1' → 删除成功（deletedSuccess），本地清理
 *   type='2' → 失败（failed），本地保留可重试
 *   type='3' → sourceId 不存在，但**仍视为删除成功**（本地同样清理），
 *              汇总时通过 deletedSourceMissing 与 deletedSuccess 区分
 *
 * 关键不变量：deletedSuccess ∪ deletedSourceMissing === synced（本地都清理）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---- Mock deleteTestCase（来自 http.ts）----
const mockDeleteTestCase = vi.fn();
vi.mock('../services/http', () => ({
    deleteTestCase: (...args: any[]) => mockDeleteTestCase(...args),
}));

// ---- Mock resolveTaskInfoOrNull / TelemetryService / vscode 依赖 ----
vi.mock('../handlers/pushCore.stages', () => ({
    resolveTaskInfoOrNull: vi.fn().mockResolvedValue({
        status: 'ok',
        taskInfo: { testTaskNo: 'TT001', subTestTaskId: 'ST001' },
    }),
}));
vi.mock('../utils/telemetry', () => ({
    TelemetryService: {
        sendTelemetryEvent: vi.fn(),
        sendTelemetryErrorEvent: vi.fn(),
    },
}));
vi.mock('vscode', () => ({
    ExtensionContext: class {},
}));

import { syncDeletedRows, ensureDeletedRowsFile } from '../utils/deletedRowsStore';

// 初始化 cachedContext（syncDeletedRows 内部使用）
import * as deletedRowsStore from '../utils/deletedRowsStore';

function mkTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'delStore-'));
}

function writeYaml(dir: string, name: string, content: string): string {
    const fp = path.join(dir, name);
    fs.writeFileSync(fp, content, 'utf-8');
    return fp;
}

const YAML = `- testcase_id: TC001
  name: 案例1
- testcase_id: TC002
  name: 案例2
- testcase_id: TC003
  name: 案例3
- testcase_id: TC004
  name: 案例4
`;

describe('syncDeletedRows · type 分档', () => {
    let dir: string;
    let fp: string;

    beforeEach(async () => {
        dir = mkTmpDir();
        fp = writeYaml(dir, 'cases.yaml', YAML);
        // 模拟扩展已激活的 cachedContext
        await ensureDeletedRowsFile({ globalStorageUri: { fsPath: dir } } as any);
        vi.clearAllMocks();
    });
    afterEach(() => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('type=1/2/3 混合：1 与 3 都进 synced，且分别计入 deletedSuccess / deletedSourceMissing', async () => {
        mockDeleteTestCase.mockResolvedValue({
            returnCode: 'SUC0000',
            errorMsg: '',
            body: [
                { sourceId: 'TC001', type: '1' }, // 删除成功
                { sourceId: 'TC002', type: '2', data: '无效的案例类型' }, // 失败，data 为失败原因
                { sourceId: 'TC003', type: '3' }, // sourceId 不存在，仍算成功
                { sourceId: 'TC004', type: '1' }, // 删除成功
            ],
        });

        const res = await syncDeletedRows(fp, ['TC001', 'TC002', 'TC003', 'TC004']);

        // synced 包含 1 和 3（都清理本地）
        expect(res.synced.sort()).toEqual(['TC001', 'TC003', 'TC004']);
        // 失败仅 type=2
        expect(res.failed.map(f => f.tsId)).toEqual(['TC002']);
        // 失败原因取接口返回的 data 值
        expect(res.failed[0].reason).toBe('无效的案例类型');
        // 汇总分档
        expect(res.deletedSuccess.sort()).toEqual(['TC001', 'TC004']);
        expect(res.deletedSourceMissing).toEqual(['TC003']);
    });

    it('仅 type=3（全不存在）：全部进 deletedSourceMissing，failed 为空', async () => {
        mockDeleteTestCase.mockResolvedValue({
            returnCode: 'SUC0000',
            errorMsg: '',
            body: [
                { sourceId: 'TC001', type: '3' },
                { sourceId: 'TC002', type: '3' },
            ],
        });

        const res = await syncDeletedRows(fp, ['TC001', 'TC002']);

        expect(res.synced.sort()).toEqual(['TC001', 'TC002']);
        expect(res.deletedSourceMissing.sort()).toEqual(['TC001', 'TC002']);
        expect(res.deletedSuccess).toEqual([]);
        expect(res.failed).toEqual([]);
    });

    it('接口未返回某 sourceId 结果 → 保守按失败处理', async () => {
        mockDeleteTestCase.mockResolvedValue({
            returnCode: 'SUC0000',
            errorMsg: '',
            body: [
                { sourceId: 'TC001', type: '1' },
                // TC002 未返回
            ],
        });

        const res = await syncDeletedRows(fp, ['TC001', 'TC002']);

        expect(res.synced).toEqual(['TC001']);
        expect(res.failed.map(f => f.tsId)).toEqual(['TC002']);
        expect(res.deletedSuccess).toEqual(['TC001']);
        expect(res.deletedSourceMissing).toEqual([]);
    });

    it('type=2 接口未返回 data → 兜底为"线上删除失败"', async () => {
        mockDeleteTestCase.mockResolvedValue({
            returnCode: 'SUC0000',
            errorMsg: '',
            body: [
                { sourceId: 'TC001', type: '2' }, // 失败且无 data 字段
            ],
        });

        const res = await syncDeletedRows(fp, ['TC001']);

        expect(res.synced).toEqual([]);
        expect(res.failed.map(f => f.tsId)).toEqual(['TC001']);
        expect(res.failed[0].reason).toBe('线上删除失败');
    });

    it('returnCode 非 SUC0000 → 整体失败，全部进 failed', async () => {
        mockDeleteTestCase.mockResolvedValue({
            returnCode: 'ERR999',
            errorMsg: '服务异常',
            body: [],
        });

        const res = await syncDeletedRows(fp, ['TC001', 'TC002']);

        expect(res.synced).toEqual([]);
        expect(res.deletedSuccess).toEqual([]);
        expect(res.deletedSourceMissing).toEqual([]);
        expect(res.failed.map(f => f.tsId).sort()).toEqual(['TC001', 'TC002']);
    });
});
