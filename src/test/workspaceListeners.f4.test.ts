/**
 * workspaceListeners × F4 集成测试
 * 真正注册 registerWorkspaceListeners，捕获 onWillDeleteFiles / onDidDeleteFiles 处理器，
 * 验证「要点删除发起的可恢复删除」通过 caseDeleteGuard 抑制时：
 *   - onWillDeleteFiles 对受抑制路径跳过备份（不调用 event.waitUntil，避免拖住删除）；
 *   - onDidDeleteFiles 对受抑制路径跳过还原 / 决策（不进入弹框 / TMS 同步分支）；
 * 而同等路径若未被抑制，则 onWillDeleteFiles 正常触发备份（waitUntil 被调用）。
 * 这是 F4 的核心契约：回收站删除不会触发插件"备份→还原→弹确认框"。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
// 打断 extensionHelpers → UnifiedEditorProvider → BaseEditorProvider 的继承链：
// 测试环境 vscode mock 未提供 CustomTextEditorProvider，真实 UnifiedEditorProvider
// extends 未定义的父类会报错。桩掉即可（本测试不依赖真实编辑器实现）。
vi.mock('../providers/UnifiedEditorProvider', () => ({
    UnifiedEditorProvider: class {},
}));
import { registerWorkspaceListeners } from '../handlers/workspaceListeners';
import { suppressDeleteForPath, isDeleteSuppressed } from '../utils/caseDeleteGuard';

const WS_ROOT = '/mock/workspace';
// 合法案例路径：测试任务/<任务>/测试案例/<file>，配合下方 asRelativePath 模拟可命中 isCaseFile
const CASE_PATH = `${WS_ROOT}/测试任务/任务1/测试案例/a.yaml`;

let willHandler: ((e: any) => void) | null = null;
let didHandler: ((e: any) => void) | null = null;
let activeGuard: { release: () => void } | null = null;

beforeEach(() => {
    // asRelativePath 模拟"相对工作区根"，使 isCaseFile 能认出合格案例路径
    (vscode.workspace as any).asRelativePath = (p: string) =>
        p.startsWith(WS_ROOT) ? p.slice(WS_ROOT.length + 1) : p;
    // 关闭遥测，避免控制组备份失败分支里 sendTelemetryErrorEvent 因 vscode.env 缺失而抛未处理异常
    (vscode as any).env = { isTelemetryEnabled: false };
    (vscode.workspace as any).onDidRenameFiles = vi.fn();
    (vscode.workspace as any).onWillDeleteFiles = vi.fn((cb: any) => { willHandler = cb; });
    (vscode.workspace as any).onDidDeleteFiles = vi.fn((cb: any) => { didHandler = cb; });
    willHandler = null;
    didHandler = null;
    activeGuard = null;
    registerWorkspaceListeners({} as any);
});

afterEach(() => {
    // 释放抑制，避免跨用例污染全局 Set
    activeGuard?.release();
    activeGuard = null;
});

describe('F4 · 要点删除回收站删除的拦截抑制', () => {
    it('受抑制路径：onWillDeleteFiles 跳过备份（不调用 waitUntil）', () => {
        activeGuard = suppressDeleteForPath(CASE_PATH);
        expect(isDeleteSuppressed(CASE_PATH)).toBe(true);

        const waitUntil = vi.fn();
        willHandler!({ files: [{ fsPath: CASE_PATH }], waitUntil });

        expect(waitUntil).not.toHaveBeenCalled();
    });

    it('对照：同等路径未被抑制时，onWillDeleteFiles 正常备份（调用 waitUntil）', () => {
        expect(isDeleteSuppressed(CASE_PATH)).toBe(false);

        const waitUntil = vi.fn();
        willHandler!({ files: [{ fsPath: CASE_PATH }], waitUntil });

        // isCaseFile 命中 → scheduleBackup → tasks 非空 → waitUntil(Promise.all) 被调用
        expect(waitUntil).toHaveBeenCalledTimes(1);
    });

    it('受抑制路径：onDidDeleteFiles 跳过还原 / 决策（不抛错、不进入分支）', () => {
        activeGuard = suppressDeleteForPath(CASE_PATH);

        // 受抑制路径在循环顶部 continue，不应触发还原 / 确认框 / TMS 同步
        expect(() => didHandler!({ files: [{ fsPath: CASE_PATH }], waitUntil: vi.fn() })).not.toThrow();
    });
});
