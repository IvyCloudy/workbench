/**
 * 编辑期校验「打开弹窗」抑制机制测试
 *
 * 背景：结果页（批量删除 / 批量推送）点击跳转文件时，曾出现"先弹案例合法性校验、
 * 关掉后才看到删除 / 推送结果"的问题。根因是旧的抑制标志为瞬时布尔——在
 * executeCommand('vscode.openWith') 兑现时即被复位，赶不上 CustomEditor 的
 * resolveWebviewView 内异步执行的打开校验（triggerEditValidationOnWebviewOpen），
 * 弹窗照弹。
 * 现机制：按文件路径抑制（suppressEditValidationPromptForFile），由调用方在
 * 面板 ready（BaseEditorProvider.waitReady 兑现，必晚于该校验）后清除。
 *
 * 本测试直接驱动 requestEditValidation(immediate + promptOnMissing)，
 * 验证：默认弹 → 抑制期间不弹 → 清除后恢复弹，且抑制按路径精确生效。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// BaseEditorProvider：仅 mock 弹窗 / 刷新两个静态通道
vi.mock('../providers/BaseEditorProvider', () => ({
    BaseEditorProvider: {
        postFileLevelPreValidateGate: vi.fn(async () => {}),
        postEditValidationRefresh: vi.fn(),
    },
}));
// 失败盘持久化：mock，避免真实写盘
vi.mock('../utils/pushFailureStore', () => ({
    persistPushFailures: vi.fn(async () => {}),
    collectFailureColumns: vi.fn(() => ''),
    clearFailures: vi.fn(async () => {}),
    getFailures: vi.fn(() => ({})),
}));
// 遥测：mock，避免依赖 vscode.env
vi.mock('../utils/telemetry', () => ({
    TelemetryService: { sendTelemetryEvent: vi.fn(), sendTelemetryErrorEvent: vi.fn() },
}));
// 路径合法性校验：mock，隔离接口；用 spy 断言编辑期校验传入的按需查询模式
vi.mock('../utils/casePathValidator', () => ({
    collectPathFailuresForFile: vi.fn(async () => []),
}));

import {
    requestEditValidation,
    suppressEditValidationPromptForFile,
    clearEditValidationPromptSuppressionForFile,
} from '../preValidate/editValidationHandler';
import { BaseEditorProvider } from '../providers/BaseEditorProvider';
import { collectPathFailuresForFile } from '../utils/casePathValidator';
import { persistPushFailures, clearFailures } from '../utils/pushFailureStore';

const gateSpy = BaseEditorProvider.postFileLevelPreValidateGate as any;
const pathSpy = collectPathFailuresForFile as any;
const persistSpy = persistPushFailures as any;
const clearSpy = clearFailures as any;

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editval-'));
    // 合规目录口径：测试任务/<任务>/测试案例/<file>
    (vscode.workspace as any).asRelativePath = (p: string) =>
        `测试任务/任务1/测试案例/${path.basename(p)}`;
    gateSpy.mockClear();
    pathSpy.mockClear();
    persistSpy.mockClear();
    clearSpy.mockClear();
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * 写一个"有打开校验问题"的案例文件：
 *   - 含 testcase_id 列 → 过 containsTestCaseId 案例闸门；
 *   - 首行 tsId 为占位值 TESTCASE_ID → 命中行级占位校验（error）；
 *   - 仅两列 → 缺大量必填列 → 命中文件级缺列检测。
 * 任一命中都会触发打开通路弹窗。
 */
function writeCaseFileWithIssues(name: string): string {
    const fp = path.join(tmpDir, name);
    fs.writeFileSync(fp, 'testcase_id,name\nTESTCASE_ID,Alice\n');
    return fp;
}

describe('编辑期校验 · 打开弹窗抑制（结果页跳转不做合法性校验）', () => {
    it('默认（无抑制）：打开通路有校验问题 → 弹窗', async () => {
        const fp = writeCaseFileWithIssues('case.csv');
        await requestEditValidation(fp, { immediate: true, promptOnMissing: true });
        expect(gateSpy).toHaveBeenCalledTimes(1);
    });

    it('抑制期间：同一文件的打开通路不弹窗', async () => {
        const fp = writeCaseFileWithIssues('case.csv');
        suppressEditValidationPromptForFile(fp);
        await requestEditValidation(fp, { immediate: true, promptOnMissing: true });
        expect(gateSpy).not.toHaveBeenCalled();
    });

    it('抑制按文件路径生效：不影响其它文件的打开弹窗', async () => {
        const aFp = writeCaseFileWithIssues('a.csv');
        const bFp = writeCaseFileWithIssues('b.csv');
        suppressEditValidationPromptForFile(aFp);
        await requestEditValidation(aFp, { immediate: true, promptOnMissing: true });
        await requestEditValidation(bFp, { immediate: true, promptOnMissing: true });
        expect(gateSpy).toHaveBeenCalledTimes(1);
        expect(gateSpy.mock.calls[0][0]).toBe(bFp); // 仅 b 弹窗
    });

    it('保存 / 编辑通路（promptOnMissing=false）本就不弹窗，与抑制无关', async () => {
        const fp = writeCaseFileWithIssues('case.csv');
        await requestEditValidation(fp, { immediate: true, promptOnMissing: false });
        expect(gateSpy).not.toHaveBeenCalled();
    });

    it('清除抑制后：打开通路恢复弹窗（不影响用户之后正常打开同一文件）', async () => {
        const fp = writeCaseFileWithIssues('case.csv');
        suppressEditValidationPromptForFile(fp);
        await requestEditValidation(fp, { immediate: true, promptOnMissing: true });
        expect(gateSpy).not.toHaveBeenCalled();

        clearEditValidationPromptSuppressionForFile(fp);
        await requestEditValidation(fp, { immediate: true, promptOnMissing: true });
        expect(gateSpy).toHaveBeenCalledTimes(1);
    });

    it('一次打开会触发多个校验点（onDidOpenTextDocument + webview-open）：抑制对同一文件全程有效', async () => {
        const fp = writeCaseFileWithIssues('case.csv');
        suppressEditValidationPromptForFile(fp);
        // 模拟同一次打开的两个触发点连续校验（旧布尔方案会因时序漏掉第二个）
        await requestEditValidation(fp, { immediate: true, promptOnMissing: true });
        await requestEditValidation(fp, { immediate: true, promptOnMissing: true });
        expect(gateSpy).not.toHaveBeenCalled();
    });

    it('非案例文件（无 testcase_id 列）：本就不弹窗（既有闸门不受抑制改动影响）', async () => {
        const fp = path.join(tmpDir, 'plain.csv');
        fs.writeFileSync(fp, 'name,age\nAlice,30\n');
        await requestEditValidation(fp, { immediate: true, promptOnMissing: true });
        expect(gateSpy).not.toHaveBeenCalled();
    });

    it('保存通路复用已判定的路径失败项，覆盖式写盘不清掉 path 红格', async () => {
        const fp = writeCaseFileWithIssues('case.csv');
        const pathFailure = {
            tsId: 'TESTCASE_ID',
            reason: '路径问题：路径为功能条目，无测试要点，请核对路径',
            field: 'testCasePath',
            columnName: '案例路径',
            category: 'casePath',
            severity: 'error',
        };
        pathSpy.mockResolvedValueOnce([pathFailure]);

        await requestEditValidation(fp, { immediate: true, promptOnMissing: false });

        // 覆盖式写盘仍带上 pathInvalid 项，且不会走 clearFailures 清空整张失败盘
        expect(persistSpy).toHaveBeenCalledTimes(1);
        expect(persistSpy.mock.calls[0][2]).toEqual(expect.arrayContaining([
            expect.objectContaining({ tsId: 'TESTCASE_ID', field: 'testCasePath', severity: 'error' }),
        ]));
        expect(clearSpy).not.toHaveBeenCalled();
    });

    it('路径判定走同一条编辑期校验闭环：打开全量查、保存按需增量查', async () => {
        const fp = writeCaseFileWithIssues('case.csv');
        await requestEditValidation(fp, { immediate: true, promptOnMissing: true });
        // 第 5 个参数为按需查询开关；打开 / 格式校验全量查线上最新状态
        expect(pathSpy).toHaveBeenCalledTimes(1);
        expect(pathSpy.mock.calls[0][1]).toEqual(expect.any(Array));
        expect(pathSpy.mock.calls[0][4]).toEqual({ incremental: false });

        await requestEditValidation(fp, { immediate: true, promptOnMissing: false });
        expect(pathSpy).toHaveBeenCalledTimes(2);
        expect(pathSpy.mock.calls[1][4]).toEqual({ incremental: true });
    });
});
