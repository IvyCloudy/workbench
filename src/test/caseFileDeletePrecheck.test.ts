/**
 * 案例文件删除拦截 · 预检阻断单元测试
 * ----------------------------------------------------------------------------
 * 覆盖 onWillDeleteFiles 阶段 handleCaseFileWillDelete 的「预检失败时阻断删除」语义，
 * 与「编辑器内删除案例」「推送测试案例」的预校验失败即中止、并透传 errorMsg 的行为保持一致：
 *
 *   - 未绑定测试任务        → 阻断（needRestore=true，透传未绑定提示）
 *   - 扩展上下文缺失        → 阻断（避免"本地删了线上还在"）
 *   - 删除确认接口非 SUC0000 → 阻断（保留返回码，did 阶段弹窗单独展示「返回码：xxx」）
 *   - 删除确认接口异常      → 阻断（precheckScenePrefix=删除前校验异常）
 *   - 全部本地未推送行       → 不阻断、不调接口，正常放行物理删除
 *   - 绑定正常且预检通过     → 进入确认并调用线上删除，全部成功则放行
 *
 * 测试通过 peekWillDeleteResult 读取 willDeleteResults 中由 handler 写入的「最终意图」，
 * 直接断言阻断 / 放行判定，无需触发 onDidDeleteFiles 的文件重建。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---- Mock TelemetryService（在引入被测模块前完成）----
const telemetryEvents: Array<{ kind: 'event' | 'error'; name: string; props: any }> = [];
vi.mock('../utils/telemetry', () => ({
    TelemetryService: {
        sendTelemetryEvent: vi.fn((name: string, props?: any) =>
            telemetryEvents.push({ kind: 'event', name, props })),
        sendTelemetryErrorEvent: vi.fn((name: string, props?: any) =>
            telemetryEvents.push({ kind: 'error', name, props })),
    },
}));

// ---- 可控依赖（hoisted 保证在 vi.mock 工厂前可用）----
const mocks = vi.hoisted(() => ({
    getCurrentTaskInfo: vi.fn(),
    confirmDeleteTestCase: vi.fn(),
    syncDeletedRows: vi.fn(),
    showDeleteConfirmSimpleModal: vi.fn(),
    confirmCaseFileDeleteWithDetails: vi.fn(),
}));

vi.mock('../utils/commands', () => ({
    getCurrentTaskInfo: (...a: any[]) => mocks.getCurrentTaskInfo(...a),
}));
// 打断 BaseEditorProvider ⇄ UnifiedEditorProvider ⇄ extensionHelpers 的循环依赖，
// 避免测试导入 workspaceListeners 时因模块求值顺序触发 "Class extends value undefined"。
// will 阶段不依赖 BaseEditorProvider 的真实实现（getPanel 仅 did 阶段使用），桩即可。
vi.mock('../providers/BaseEditorProvider', () => ({
    BaseEditorProvider: class { static getPanel() { return undefined; } },
}));
vi.mock('../services/http', async (importActual) => ({
    ...(await importActual<typeof import('../services/http')>()),
    confirmDeleteTestCase: (...a: any[]) => mocks.confirmDeleteTestCase(...a),
}));
vi.mock('../utils/deletedRowsStore', async (importActual) => ({
    ...(await importActual<typeof import('../utils/deletedRowsStore')>()),
    syncDeletedRows: (...a: any[]) => mocks.syncDeletedRows(...a),
}));
vi.mock('../utils/messageExtras', async (importActual) => ({
    ...(await importActual<typeof import('../utils/messageExtras')>()),
    showDeleteConfirmSimpleModal: (...a: any[]) => mocks.showDeleteConfirmSimpleModal(...a),
}));
vi.mock('../utils/deleteFeedback', async (importActual) => ({
    ...(await importActual<typeof import('../utils/deleteFeedback')>()),
    confirmCaseFileDeleteWithDetails: (...a: any[]) => mocks.confirmCaseFileDeleteWithDetails(...a),
}));

import { handleCaseFileWillDelete, peekWillDeleteResult } from '../handlers/workspaceListeners';

const VALID_ID = '123e4567-e89b-12d3-a456-426614174000';
const TASK_INFO = { testTaskNo: 'TT001', subTestTaskId: 'ST001' };

let tmpDir: string;
function writeCsv(name: string, rows: string[]): string {
    const fp = path.join(tmpDir, name);
    fs.writeFileSync(fp, rows.join('\n'), 'utf-8');
    return fp;
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caseDelPrecheck-'));
    telemetryEvents.length = 0;
    mocks.getCurrentTaskInfo.mockReset();
    mocks.confirmDeleteTestCase.mockReset();
    mocks.syncDeletedRows.mockReset();
    mocks.showDeleteConfirmSimpleModal.mockReset();
    mocks.confirmCaseFileDeleteWithDetails.mockReset();
    // 默认：已绑定任务（绑定正常分支通过）
    mocks.getCurrentTaskInfo.mockResolvedValue({ bind: true, taskInfo: TASK_INFO });
});

afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('案例文件删除拦截 · 预检阻断（与推送测试案例逻辑一致）', () => {
    it('未绑定测试任务 → 阻断删除，透传未绑定提示', async () => {
        mocks.getCurrentTaskInfo.mockResolvedValue({ bind: false });
        const fp = writeCsv('case.csv', ['testcase_id,path,name', `${VALID_ID},/功能测试/,案例A`]);
        await handleCaseFileWillDelete(fp, undefined, {} as any);
        const r = peekWillDeleteResult(fp) as any;
        expect(r).toBeDefined();
        expect(r.needRestore).toBe(true);
        expect(r.error).toContain('未绑定测试任务');
        expect(r.precheckScenePrefix).toBe('删除前校验未通过');
        expect(mocks.confirmDeleteTestCase).not.toHaveBeenCalled();
        expect(mocks.syncDeletedRows).not.toHaveBeenCalled();
    });

    it('扩展上下文缺失 → 阻断删除', async () => {
        const fp = writeCsv('case.csv', ['testcase_id,path,name', `${VALID_ID},/功能测试/,案例A`]);
        await handleCaseFileWillDelete(fp, undefined, undefined);
        const r = peekWillDeleteResult(fp) as any;
        expect(r.needRestore).toBe(true);
        expect(r.error).toContain('扩展上下文未初始化');
        expect(r.precheckScenePrefix).toBe('删除前校验未通过');
        expect(mocks.confirmDeleteTestCase).not.toHaveBeenCalled();
    });

    it('删除确认接口返回非 SUC0000 → 阻断，并保留返回码', async () => {
        mocks.confirmDeleteTestCase.mockResolvedValue({ returnCode: 'SYS5001', errorMsg: '校验未通过', body: [] });
        const fp = writeCsv('case.csv', ['testcase_id,path,name', `${VALID_ID},/功能测试/,案例A`]);
        await handleCaseFileWillDelete(fp, undefined, {} as any);
        const r = peekWillDeleteResult(fp) as any;
        expect(r.needRestore).toBe(true);
        expect(r.error).toBe('校验未通过');
        expect(r.precheckScenePrefix).toBe('删除前校验未通过');
        expect(r.precheckReturnCode).toBe('SYS5001');
        expect(mocks.confirmDeleteTestCase).toHaveBeenCalledTimes(1);
        expect(mocks.syncDeletedRows).not.toHaveBeenCalled();
    });

    it('删除确认接口异常 → 阻断，场景前缀为校验异常', async () => {
        mocks.confirmDeleteTestCase.mockRejectedValue(new Error('网络异常'));
        const fp = writeCsv('case.csv', ['testcase_id,path,name', `${VALID_ID},/功能测试/,案例A`]);
        await handleCaseFileWillDelete(fp, undefined, {} as any);
        const r = peekWillDeleteResult(fp) as any;
        expect(r.needRestore).toBe(true);
        expect(r.error).toContain('网络异常');
        expect(r.precheckScenePrefix).toBe('删除前校验异常');
        expect(mocks.syncDeletedRows).not.toHaveBeenCalled();
    });

    it('全部为本地未推送行 → 不阻断、不调接口，正常放行删除', async () => {
        const fp = writeCsv('local.csv', ['testcase_id,path,name', ',,案例A']);
        await handleCaseFileWillDelete(fp, undefined, {} as any);
        const r = peekWillDeleteResult(fp) as any;
        expect(r.needRestore).toBe(false);
        expect(r.reportable).toBe(true);
        expect(mocks.confirmDeleteTestCase).not.toHaveBeenCalled();
        expect(mocks.syncDeletedRows).not.toHaveBeenCalled();
    });

    it('绑定正常且预检通过 → 进入确认并调用线上删除，全部成功则放行', async () => {
        mocks.confirmDeleteTestCase.mockResolvedValue({ returnCode: 'SUC0000', body: [] });
        mocks.showDeleteConfirmSimpleModal.mockResolvedValue(true);
        mocks.syncDeletedRows.mockResolvedValue({
            synced: [VALID_ID], failed: [], deletedSuccess: [VALID_ID], deletedSourceMissing: [],
        });
        const fp = writeCsv('case.csv', ['testcase_id,path,name', `${VALID_ID},/功能测试/,案例A`]);
        await handleCaseFileWillDelete(fp, undefined, {} as any);
        const r = peekWillDeleteResult(fp) as any;
        expect(mocks.confirmDeleteTestCase).toHaveBeenCalledTimes(1);
        expect(mocks.showDeleteConfirmSimpleModal).toHaveBeenCalledTimes(1);
        expect(mocks.syncDeletedRows).toHaveBeenCalledTimes(1);
        expect(r.needRestore).toBe(false);
        expect(r.successCount).toBe(1);
    });

    it('删除确认弹窗的「x 条案例」= 确认接口返回 type=1+type=2 总数（不含 type=3）', async () => {
        // 确认接口返回 4 条：type=1 (2 条) + type=2 (1 条，带关联) + type=3 (1 条，不存在)
        // 期望弹窗计数 x = 2 + 1 = 3（type=3 不计入"会同步删除"的条数）
        mocks.confirmDeleteTestCase.mockResolvedValue({
            returnCode: 'SUC0000',
            body: [
                { sourceId: 'ID1', type: 1, data: [{ sourceId: 'ID1' }] },
                { sourceId: 'ID2', type: 1, data: [{ sourceId: 'ID2' }] },
                { sourceId: 'ID3', type: 2, data: [{ sourceId: 'ID3', hasExec: 'Y', hasBug: 'N' }] },
                { sourceId: 'ID4', type: 3, data: [] },
            ],
        });
        // type=2 存在关联 → 走带表格弹窗 confirmCaseFileDeleteWithDetails
        mocks.confirmCaseFileDeleteWithDetails.mockResolvedValue(true);
        mocks.showDeleteConfirmSimpleModal.mockResolvedValue(true);
        mocks.syncDeletedRows.mockResolvedValue({
            synced: ['ID1', 'ID2', 'ID3'], failed: [], deletedSuccess: ['ID1', 'ID2', 'ID3'], deletedSourceMissing: ['ID4'],
        });
        const fp = writeCsv('case2.csv', ['testcase_id,path,name',
            'ID1,/功能测试/,案例A', 'ID2,/功能测试/,案例B', 'ID3,/功能测试/,案例C', 'ID4,/功能测试/,案例D']);
        await handleCaseFileWillDelete(fp, undefined, {} as any);
        // 带表格弹窗被调用，且 caseCount === 3（type=1×2 + type=2×1）
        expect(mocks.confirmCaseFileDeleteWithDetails).toHaveBeenCalledTimes(1);
        const modalArg = mocks.confirmCaseFileDeleteWithDetails.mock.calls[0][0];
        expect(modalArg.caseCount).toBe(3);
        // type=2 的关联明细（1 条）用于表格展示
        expect(modalArg.items.length).toBe(1);
    });

    it('删除确认接口无响应（被 VSCode waitUntil 内部超时强制中断）→ 条目停留占位，did 阶段将弹"校验未完成"提示', async () => {
        // 模拟后端确认接口一直不返回（永不 resolve），等价于用户遇到的
        // "Running 'File Delete' participants... 超时"——VSCode 内部 waitUntil 超时后
        // 强制放行物理删除，而 handleCaseFileWillDelete 仍在 await confirmDeleteTestCase。
        // 此时 willDeleteResults 停留在入口占位状态，正是 handleDidDeleteCaseFile 中
        // isInterruptedPlaceholder 分支要兜底的"被中断占位"场景。
        mocks.confirmDeleteTestCase.mockReturnValue(new Promise<void>(() => { /* 永不 resolve */ }));
        const fp = writeCsv('case.csv', ['testcase_id,path,name', `${VALID_ID},/功能测试/,案例A`]);

        // 用短超时模拟 VSCode 内部 waitUntil 超时强制中断（不让测试无限挂起）
        const willDone = handleCaseFileWillDelete(fp, undefined, {} as any);
        const guard = new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 300));
        const outcome = await Promise.race([willDone.then(() => 'done' as const), guard]);
        expect(outcome).toBe('timeout'); // handler 确实被"中断"卡在预检 await 上

        // 中断后 willDeleteResults 必须仍停留在入口占位，且特征符合 isInterruptedPlaceholder 判定：
        //   needRestore=true（占位） + 无 error + 无 precheckScenePrefix + total=0 + failures=[]
        // 该特征确保 did 阶段会重建文件并弹出"删除前校验未完成"提示，而不是静默无反馈。
        const r = peekWillDeleteResult(fp) as any;
        expect(r).toBeDefined();
        expect(r.needRestore).toBe(true);
        expect(r.isUserCancel).toBeUndefined();
        expect(r.error).toBeUndefined();
        expect(r.precheckScenePrefix).toBeUndefined();
        expect(r.total).toBe(0);
        expect(r.failures).toEqual([]);
        // 标记：意图尚未回填（被中断），供 did 阶段 / 监控识别
        expect(r.intentSet).toBe(false);
    });

    it('确认弹窗显示前 token 已被取消（进度条 Cancel）→ 标记 isUserCancel 且 cancelledBeforeConfirm', async () => {
        // 模拟确认接口正常返回（无 type=2 关联），但 event.token 在「删除确认弹窗显示之前」
        // 就已被取消（用户在 "Running File Delete" 进度条点了 Cancel）。此时 confirmCaseFileDelete
        // 直接 return false 且从未弹出确认弹窗，需标记 cancelledBeforeConfirm，使 did 阶段
        // 给用户一个明确反馈（否则文件被静默保留、用户毫无感知）。
        mocks.confirmDeleteTestCase.mockResolvedValue({ returnCode: 'SUC0000', body: [] });
        const token = { isCancellationRequested: true } as any;
        const fp = writeCsv('case.csv', ['testcase_id,path,name', `${VALID_ID},/功能测试/,案例A`]);
        await handleCaseFileWillDelete(fp, token, {} as any);
        const r = peekWillDeleteResult(fp) as any;
        expect(r.isUserCancel).toBe(true);
        expect(r.cancelledBeforeConfirm).toBe(true);
        expect(mocks.syncDeletedRows).not.toHaveBeenCalled();
    });

    it('确认接口响应较长（handler 长时间未结束）→ 兜底 TTL 不清理条目与备份，杜绝文件丢失', async () => {
        // ★ 回归防护：willDeleteResults 条目是 did 阶段"是否重建文件"的唯一依据，
        //   backupPath 是文件原始内容的唯一副本。若确认接口响应较慢导致 handler
        //   耗时超过 WILL_DELETE_ENTRY_TTL_MS(60s)，旧的 TTL 逻辑会删除条目并 unlink 备份，
        //   使 did 阶段 consume 到 undefined → 文件被物理删除后无人重建 → 文件永久丢失。
        //   修复后：handler 未结束（handlerDone=false）时 TTL 只重新排队，绝不清理。
        vi.useFakeTimers();
        try {
            mocks.confirmDeleteTestCase.mockReturnValue(new Promise<void>(() => { /* 永不 resolve：模拟接口极慢 */ }));
            const fp = writeCsv('case.csv', ['testcase_id,path,name', `${VALID_ID},/功能测试/,案例A`]);
            const willDone = handleCaseFileWillDelete(fp, undefined, {} as any);
            willDone.catch(() => { /* 忽略：本用例不关心其最终结果 */ });

            // 快进远超 TTL（60s × 3）
            await vi.advanceTimersByTimeAsync(60_000 * 3);

            const r = peekWillDeleteResult(fp) as any;
            expect(r).toBeDefined();          // 条目必须仍在 → did 阶段才能重建文件
            expect(r.handlerDone).toBe(false);
            if (r.backupPath) {
                expect(fs.existsSync(r.backupPath)).toBe(true); // 备份必须仍在
            }
        } finally {
            vi.useRealTimers();
        }
    });
});
