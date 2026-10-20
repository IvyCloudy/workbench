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
});
