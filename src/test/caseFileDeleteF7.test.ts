/**
 * workspaceListeners × F7 集成测试（did 阶段门控版）
 *
 * 设计：F7 门控已从 will 阶段迁移到 did 阶段（handleCaseFilesDidDelete 入口）。
 *   - will 阶段：对所有 path 级案例文件仅做 copyFileSync 备份（H1 零 parse），不再跳过非案例文件；
 *   - did 阶段：解析备份，把"不含 testcase_id"的文件拆为 skipEntries —— 不还原、不拦截、不重建，
 *     文件由 VSCode 按普通文件删除；含 testcase_id 的文件照常还原走案例流程。
 *
 * 本测试通过真实注册 registerWorkspaceListeners 并捕获 will / did handler，
 * 用真实临时文件 + asRelativePath mock 让 isCaseFile 命中合格案例路径，并模拟 VSCode 在 did 前已物理删除原文件。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// 屏蔽 F7 流程中真实 UI / 网络依赖，仅验证"还原与否"的核心行为
vi.mock('../providers/UnifiedEditorProvider', () => ({ UnifiedEditorProvider: class {} }));
vi.mock('../utils/pushUI', () => ({ showPushSummary: vi.fn() }));
vi.mock('../utils/messageExtras', () => ({
    showBatchDeleteConfirmModal: vi.fn(async () => true),
    showDeleteConfirmSimpleModal: vi.fn(async () => true),
}));
vi.mock('../utils/message', () => ({ showModal: vi.fn() }));
vi.mock('../utils/deleteFeedback', () => ({
    confirmCaseFileDeleteWithDetails: vi.fn(async () => true),
    reportDeleteResult: vi.fn(),
    postDeleteRowsResult: vi.fn(),
}));
vi.mock('../services/http', () => ({
    confirmDeleteTestCase: vi.fn(async () => ({ returnCode: 'SUC0000', body: [] })),
}));
vi.mock('./pushCore.stages', () => ({
    resolveTaskInfoOrNull: vi.fn(async () => ({ status: 'unbound' })),
}));

// 记录埋点事件：断言 F7 删除链路（逐文件跳过 + 批量汇总）的埋点完整性
const telemetryEvents: Array<{ kind: 'event' | 'error'; name: string; props: any }> = [];
vi.mock('../utils/telemetry', () => ({
    TelemetryService: {
        sendTelemetryEvent: vi.fn((name: string, props?: any) =>
            telemetryEvents.push({ kind: 'event', name, props })),
        sendTelemetryErrorEvent: vi.fn((name: string, props?: any) =>
            telemetryEvents.push({ kind: 'error', name, props })),
    },
}));

import { registerWorkspaceListeners } from '../handlers/workspaceListeners';
import { showPushSummary } from '../utils/pushUI';
import { showBatchDeleteConfirmModal } from '../utils/messageExtras';

let tmpWork: string;
let willHandler: ((e: any) => void) | null = null;
let didHandler: ((e: any) => void) | null = null;

beforeEach(() => {
    tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'f7work-'));
    (vscode.workspace as any).asRelativePath = (p: string) =>
        `测试任务/任务1/测试案例/${path.basename(p)}`;
    (vscode as any).env = { isTelemetryEnabled: false };
    // 批量路径（含非案例文件时走聚合）会用到 vscode.window.withProgress / vscode.ProgressLocation，补最小 mock
    (vscode as any).ProgressLocation = { Notification: 15 };
    (vscode as any).window = {
        withProgress: async (_opts: any, task: any) => task({ report() {} }, { isCancellationRequested: false }),
    };
    (vscode.workspace as any).onDidRenameFiles = vi.fn();
    (vscode.workspace as any).onWillDeleteFiles = vi.fn((cb: any) => { willHandler = cb; });
    (vscode.workspace as any).onDidDeleteFiles = vi.fn((cb: any) => { didHandler = cb; });
    willHandler = null;
    didHandler = null;
    telemetryEvents.length = 0;
    registerWorkspaceListeners({} as any);
});

afterEach(() => {
    fs.rmSync(tmpWork, { recursive: true, force: true });
});

function listBackups(): string[] {
    return fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('caseDelBak-'));
}

/** 触发 will（备份）→ 模拟 VSCode 物理删除原文件 → 触发 did（分区/还原/跳过） */
async function triggerWillAndDid(fp: string): Promise<void> {
    const waitUntil = vi.fn();
    willHandler!({ files: [{ fsPath: fp }], waitUntil });
    await new Promise((r) => setTimeout(r, 80)); // will 备份完成
    try { fs.unlinkSync(fp); } catch { /* 已由其它调用删除则忽略 */ }
    didHandler!({ files: [{ fsPath: fp }] });
    await new Promise((r) => setTimeout(r, 250)); // did 分区 + 还原/跳过完成
}

describe('F7 · 删除不含 testcase_id 的文件不视为案例文件（did 阶段门控）', () => {
    it('will 阶段仍备份所有 path 级案例文件（含非案例），保留 H1 零 parse 优化', async () => {
        const fp = path.join(tmpWork, 'plain.csv');
        fs.writeFileSync(fp, 'name,age\nAlice,30\nBob,25\n');
        const before = listBackups();
        const waitUntil = vi.fn();
        willHandler!({ files: [{ fsPath: fp }], waitUntil });
        await new Promise((r) => setTimeout(r, 80));
        const after = listBackups();
        // will 阶段不再跳过非案例文件：tmp 下应新增 1 个备份（仅 copyFileSync，不 parse）
        expect(after.length).toBe(before.length + 1);
    });

    it('不含 testcase_id 的 csv：did 阶段不还原（保持已删除），不触发案例重建', async () => {
        const fp = path.join(tmpWork, 'plain.csv');
        fs.writeFileSync(fp, 'name,age\nAlice,30\nBob,25\n');
        await triggerWillAndDid(fp);
        expect(fs.existsSync(fp)).toBe(false); // 未被还原 = 按普通文件删除
    });

    it('不含 testcase_id 的 json：同样不还原', async () => {
        const fp = path.join(tmpWork, 'plain.json');
        fs.writeFileSync(fp, JSON.stringify([{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }]));
        await triggerWillAndDid(fp);
        expect(fs.existsSync(fp)).toBe(false);
    });

    it('对照：含 testcase_id 的 csv：did 阶段正常还原（走案例流程）', async () => {
        const fp = path.join(tmpWork, 'case.csv');
        fs.writeFileSync(fp, 'testcase_id,name\na1,Alice\nb2,Bob\n');
        await triggerWillAndDid(fp);
        expect(fs.existsSync(fp)).toBe(true); // 已还原
    });

    it('对照：含 testcase_id 的 json：did 阶段正常还原', async () => {
        const fp = path.join(tmpWork, 'case.json');
        fs.writeFileSync(fp, JSON.stringify([{ testcase_id: 'a1', name: 'Alice' }]));
        await triggerWillAndDid(fp);
        expect(fs.existsSync(fp)).toBe(true);
    });

    it('计数透明：文件夹混合格式删除时，提示透出真实总删除数（含非案例扩展名文件）', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f7dir-'));
        const caseFp = path.join(dir, 'case.csv');
        fs.writeFileSync(caseFp, 'testcase_id,name\na1,Alice\n');
        const noteFp = path.join(dir, 'readme.txt'); // 非案例扩展名，will 阶段不备份、但计入真实总数
        fs.writeFileSync(noteFp, 'just a note');

        // will：以文件夹 URI 触发（VSCode 仅报文件夹本身）
        willHandler!({ files: [{ fsPath: dir }], waitUntil: vi.fn() });
        await new Promise((r) => setTimeout(r, 150)); // 等待 will 备份 + 目录递归扫描完成
        // 模拟 VSCode 物理删除整个文件夹
        fs.rmSync(dir, { recursive: true, force: true });
        // did：同样以文件夹 URI 触发
        didHandler!({ files: [{ fsPath: dir }] });
        await new Promise((r) => setTimeout(r, 500)); // 等待 did 分区 + 决策 + 结果面板

        // 结果面板 note 必须体现真实总数 = 2（case.csv + readme.txt），而非仅案例格式文件数 1；
        // 确认弹窗 header 通过 nonCaseCount 对齐总数（非案例文件不在弹窗列表中，改由 header 承担计数对齐）
        const notes: string[] = [];
        for (const c of showPushSummary.mock.calls) {
            const opt = c[2] as any;
            if (opt?.note) notes.push(opt.note);
        }
        expect(notes.length).toBeGreaterThan(0);
        expect(notes.some((n) => n.includes('共删除 2 个文件'))).toBe(true);
        expect(notes.some((n) => n.includes('1 个非案例文件已按普通文件直接删除'))).toBe(true);
        const modalNonCase = showBatchDeleteConfirmModal.mock.calls
            .map((c) => (c[1] as any)?.nonCaseCount)
            .filter((n) => typeof n === 'number' && n > 0);
        expect(modalNonCase.length).toBeGreaterThan(0);
        expect(modalNonCase[0]).toBe(1);
    });

    it('计数透明：同时选中多个根目录案例文件时，提示总数为最终值（非运行中部分值）', async () => {
        const aFp = path.join(tmpWork, 'caseA.csv');
        const bFp = path.join(tmpWork, 'caseB.csv');
        fs.writeFileSync(aFp, 'testcase_id,name\na1,Alice\n');
        fs.writeFileSync(bFp, 'testcase_id,name\nb2,Bob\n');

        // will：VSCode 报两个独立文件（非文件夹），循环中途 total 会先变 1 再变 2
        willHandler!({ files: [{ fsPath: aFp }, { fsPath: bFp }], waitUntil: vi.fn() });
        await new Promise((r) => setTimeout(r, 150)); // 等待 will 备份完成
        fs.unlinkSync(aFp);
        fs.unlinkSync(bFp);
        // did：同样两个独立文件
        didHandler!({ files: [{ fsPath: aFp }, { fsPath: bFp }] });
        await new Promise((r) => setTimeout(r, 500)); // 等待 did 分区 + 决策 + 结果面板

        // 关键：提示必须透出"共删除 2 个文件"，且 mCase(=2) ≤ total(=2)，不可出现"共删除 1 个"或负数计数
        const notes: string[] = [];
        for (const c of showPushSummary.mock.calls) {
            const opt = c[2] as any;
            if (opt?.note) notes.push(opt.note);
        }
        expect(notes.some((n) => n.includes('共删除 2 个文件'))).toBe(true);
        expect(notes.some((n) => n.includes('其余 -') || n.includes('另有 -'))).toBe(false); // 不可出现负数非案例计数
    });

    it('单个非案例文件删除：直接删除完成，不弹"删除结果"汇总面板', async () => {
        (showPushSummary as any).mockClear();
        const fp = path.join(tmpWork, 'plain.csv');
        fs.writeFileSync(fp, 'name,age\nAlice,30\nBob,25\n');
        await triggerWillAndDid(fp);
        expect(fs.existsSync(fp)).toBe(false);        // 已按普通文件删除，未还原
        expect(showPushSummary).not.toHaveBeenCalled(); // 单文件免结果面板（资源管理器消失即是反馈）

        // 埋点①：逐文件跳过事件（含文件名 + 格式维度）
        const skipped = telemetryEvents.filter(e => e.name === 'caseFileDelete.skipped.notTestCaseFile');
        expect(skipped.length).toBe(1);
        expect(skipped[0].props.filePath).toBe('plain.csv');
        expect(skipped[0].props.fileFormat).toBe('csv');
        // 埋点②：纯非案例批次也要上报批量汇总（batchTotalFiles=0 + 跳过计数=1 + 真实总数=1），
        // 否则后端无法从 caseFileDelete.batch.done 核对"纯非案例删除"规模
        const batchDone = telemetryEvents.filter(e => e.name === 'caseFileDelete.batch.done');
        expect(batchDone.length).toBe(1);
        expect(batchDone[0].props.batchTotalFiles).toBe('0');
        expect(batchDone[0].props.batchSkippedNonCaseFiles).toBe('1');
        expect(batchDone[0].props.batchTotalDeletedFiles).toBe('1');
        expect(batchDone[0].props.batchOtherNonCaseFiles).toBe('0');
    });

    it('批量删除多个非案例文件：同样不弹"删除结果"面板（仅含案例文件时才弹）', async () => {
        (showPushSummary as any).mockClear();
        (showBatchDeleteConfirmModal as any).mockClear();
        const aFp = path.join(tmpWork, 'plainA.csv');
        const bFp = path.join(tmpWork, 'plainB.csv');
        fs.writeFileSync(aFp, 'name,age\nAlice,30\n');
        fs.writeFileSync(bFp, 'name\nBob\n');
        willHandler!({ files: [{ fsPath: aFp }, { fsPath: bFp }], waitUntil: vi.fn() });
        await new Promise((r) => setTimeout(r, 150));
        fs.unlinkSync(aFp);
        fs.unlinkSync(bFp);
        didHandler!({ files: [{ fsPath: aFp }, { fsPath: bFp }] });
        await new Promise((r) => setTimeout(r, 500));
        expect(fs.existsSync(aFp)).toBe(false);
        expect(fs.existsSync(bFp)).toBe(false);
        // 纯非案例批次：不弹结果面板，也不弹删除确认框（含案例文件时才出现）
        expect(showPushSummary).not.toHaveBeenCalled();
        expect(showBatchDeleteConfirmModal).not.toHaveBeenCalled();

        // 埋点：两个逐文件跳过事件 + 一条汇总（跳过=2 / 真实总数=2）
        const skipped = telemetryEvents.filter(e => e.name === 'caseFileDelete.skipped.notTestCaseFile');
        expect(skipped.length).toBe(2);
        const batchDone = telemetryEvents.filter(e => e.name === 'caseFileDelete.batch.done');
        expect(batchDone.length).toBe(1);
        expect(batchDone[0].props.batchTotalFiles).toBe('0');
        expect(batchDone[0].props.batchSkippedNonCaseFiles).toBe('2');
        expect(batchDone[0].props.batchTotalDeletedFiles).toBe('2');
    });

    it('对照：本批含案例文件时，确认框与结果面板照常出现（含案例才需确认/结果页）', async () => {
        (showPushSummary as any).mockClear();
        (showBatchDeleteConfirmModal as any).mockClear();
        const caseFp = path.join(tmpWork, 'case.csv');
        const plainFp = path.join(tmpWork, 'plain.csv');
        fs.writeFileSync(caseFp, 'testcase_id,name\na1,Alice\n');
        fs.writeFileSync(plainFp, 'name,age\nAlice,30\n');
        willHandler!({ files: [{ fsPath: caseFp }, { fsPath: plainFp }], waitUntil: vi.fn() });
        await new Promise((r) => setTimeout(r, 150));
        fs.unlinkSync(caseFp);
        fs.unlinkSync(plainFp);
        didHandler!({ files: [{ fsPath: caseFp }, { fsPath: plainFp }] });
        await new Promise((r) => setTimeout(r, 500));

        // 含案例文件 → 走批量确认 + 结果面板，且面板同时列出案例/非案例两类行
        expect(showBatchDeleteConfirmModal).toHaveBeenCalled();
        expect(showPushSummary).toHaveBeenCalled();
        const allRows: any[][] = (showPushSummary as any).mock.calls.map((c: any[]) => c[0]);
        const flat = allRows.flat();
        expect(flat.some((r) => String(r?.fileName) === 'case.csv')).toBe(true);
        expect(flat.some((r) => String(r?.fileName) === 'plain.csv')).toBe(true); // 非案例行并入结果页
        // 埋点：1 个逐文件跳过 + 批量汇总 batchTotalFiles=1（案例数）、跳过=1、真实总数=2
        const skipped = telemetryEvents.filter(e => e.name === 'caseFileDelete.skipped.notTestCaseFile');
        expect(skipped.length).toBe(1);
        const batchDone = telemetryEvents.filter(e => e.name === 'caseFileDelete.batch.done');
        expect(batchDone.length).toBe(1);
        expect(batchDone[0].props.batchTotalFiles).toBe('1');
        expect(batchDone[0].props.batchSkippedNonCaseFiles).toBe('1');
        expect(batchDone[0].props.batchTotalDeletedFiles).toBe('2');
    });

    // ── 仅含样例数据（testcase_id 为占位文案）的案例文件：与单文件/非案例文件口径对齐 ──
    /** 写一个"仅样例数据"的案例文件：有 testcase_id 列，但行的 id 是样例占位文案 */
    function writeSampleOnlyCaseFile(name: string): string {
        const fp = path.join(tmpWork, name);
        fs.writeFileSync(fp, 'testcase_id,name\n案例唯一标识，不可修改,示例案例\n');
        return fp;
    }

    it('单个"仅样例数据"案例文件删除：静默真删，无确认框、无结果面板', async () => {
        (showPushSummary as any).mockClear();
        (showBatchDeleteConfirmModal as any).mockClear();
        const fp = writeSampleOnlyCaseFile('sample.csv');
        await triggerWillAndDid(fp);
        expect(fs.existsSync(fp)).toBe(false);          // 已真删
        expect(showPushSummary).not.toHaveBeenCalled();  // 无结果面板
        expect(showBatchDeleteConfirmModal).not.toHaveBeenCalled();
        // 埋点：intercept.init 记 nonEmptyIds=0；file.unlink 记 hardDeleteOnly 真删
        const inits = telemetryEvents.filter(e => e.name === 'caseFileDelete.intercept.init');
        expect(inits.length).toBe(1);
        expect(inits[0].props.nonEmptyIds).toBe('0');
        const unlinks = telemetryEvents.filter(e => e.name === 'caseFileDelete.file.unlink');
        expect(unlinks.length).toBe(1);
        expect(unlinks[0].props.mode).toBe('hardDeleteOnly');
        expect(unlinks[0].props.unlinkResult).toBe('ok');
    });

    it('批量删除多个"仅样例数据"案例文件：同样静默（无确认框、无结果面板），与非案例文件口径对齐', async () => {
        (showPushSummary as any).mockClear();
        (showBatchDeleteConfirmModal as any).mockClear();
        const aFp = writeSampleOnlyCaseFile('sampleA.csv');
        const bFp = writeSampleOnlyCaseFile('sampleB.csv');
        willHandler!({ files: [{ fsPath: aFp }, { fsPath: bFp }], waitUntil: vi.fn() });
        await new Promise((r) => setTimeout(r, 150));
        fs.unlinkSync(aFp);
        fs.unlinkSync(bFp);
        didHandler!({ files: [{ fsPath: aFp }, { fsPath: bFp }] });
        await new Promise((r) => setTimeout(r, 500));
        expect(fs.existsSync(aFp)).toBe(false);
        expect(fs.existsSync(bFp)).toBe(false);
        // 整批无真实案例操作 → 不弹确认框、不弹结果面板（单文件删除本就是静默的）
        expect(showBatchDeleteConfirmModal).not.toHaveBeenCalled();
        expect(showPushSummary).not.toHaveBeenCalled();

        // 埋点仍然完整：2 条 intercept.init(nonEmptyIds=0) + 2 条 hardDeleteOnly unlink + 1 条汇总
        const inits = telemetryEvents.filter(e => e.name === 'caseFileDelete.intercept.init');
        expect(inits.length).toBe(2);
        expect(inits.every(e => e.props.nonEmptyIds === '0')).toBe(true);
        const unlinks = telemetryEvents.filter(e => e.name === 'caseFileDelete.file.unlink');
        expect(unlinks.length).toBe(2);
        expect(unlinks.every(e => e.props.mode === 'hardDeleteOnly' && e.props.batch === 'true')).toBe(true);
        const batchDone = telemetryEvents.filter(e => e.name === 'caseFileDelete.batch.done');
        expect(batchDone.length).toBe(1);
        expect(batchDone[0].props.batchTotalFiles).toBe('2');      // 均为案例格式文件
        expect(batchDone[0].props.batchSkippedNonCaseFiles).toBe('0'); // 不含"非案例"跳过项
        expect(batchDone[0].props.batchTotalDeletedFiles).toBe('2');
    });

    it('对照："仅样例数据"案例文件与真实案例文件混批时，确认框与结果面板照常出现', async () => {
        (showPushSummary as any).mockClear();
        (showBatchDeleteConfirmModal as any).mockClear();
        const caseFp = path.join(tmpWork, 'case.csv');
        const sampleFp = writeSampleOnlyCaseFile('sample.csv');
        fs.writeFileSync(caseFp, 'testcase_id,name\na1,Alice\n');
        willHandler!({ files: [{ fsPath: caseFp }, { fsPath: sampleFp }], waitUntil: vi.fn() });
        await new Promise((r) => setTimeout(r, 150));
        fs.unlinkSync(caseFp);
        fs.unlinkSync(sampleFp);
        didHandler!({ files: [{ fsPath: caseFp }, { fsPath: sampleFp }] });
        await new Promise((r) => setTimeout(r, 500));

        // 含真实案例操作 → 面板照常，且两个文件都在结果清单里
        expect(showBatchDeleteConfirmModal).toHaveBeenCalled();
        expect(showPushSummary).toHaveBeenCalled();
        const flat = (showPushSummary as any).mock.calls.map((c: any[]) => c[0]).flat();
        expect(flat.some((r) => String(r?.fileName) === 'case.csv')).toBe(true);
        expect(flat.some((r) => String(r?.fileName) === 'sample.csv')).toBe(true);
        // 埋点：汇总 batchTotalFiles=2（两个案例格式文件）、跳过=0、真实总数=2
        const batchDone = telemetryEvents.filter(e => e.name === 'caseFileDelete.batch.done');
        expect(batchDone.length).toBe(1);
        expect(batchDone[0].props.batchTotalFiles).toBe('2');
        expect(batchDone[0].props.batchSkippedNonCaseFiles).toBe('0');
        expect(batchDone[0].props.batchTotalDeletedFiles).toBe('2');
    });
});
