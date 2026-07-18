/**
 * ============================================================================
 *  test/pointCaseBindingStore.test.ts
 *  point-case 绑定库单元测试（P0/P2 检视：1:1 语义、rename/remove 同步、乐观锁）
 * ----------------------------------------------------------------------------
 *  校验要点：
 *    1) setPointCases / setCasePoints 的 1:1 校验（超1报错、被占用报错）
 *    2) rename 后旧引用同步为新引用
 *    3) delete 后引用被清理
 *    4) buildBoundFileMap 覆盖 point 和 case 双向查表
 *    5) 乐观锁：expectedMtimeMs 不一致抛 ConcurrentWriteError
 * ============================================================================
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// vscode 模拟：仅接口 workspaceFolders / commands
const mockWorkspaceFolders: Array<{ uri: { fsPath: string } }> = [];
vi.mock('vscode', () => ({
    workspace: {
        get workspaceFolders() { return mockWorkspaceFolders.length ? mockWorkspaceFolders : undefined; },
    },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    commands: { executeCommand: vi.fn() },
    window: { showWarningMessage: vi.fn() },
    ThemeColor: class { constructor(public id: string) {} },
    EventEmitter: class { on() {} fire() {} event = () => ({ dispose() {} }); },
}));

// 打断潜在循环依赖
vi.mock('../providers/UnifiedEditorProvider', () => ({
    UnifiedEditorProvider: class { },
    FileTypeChecker: { checkFileFormat: () => ({ ok: true }) },
}));
vi.mock('../utils/telemetry', () => ({
    TelemetryService: {
        sendTelemetryEvent: vi.fn(),
        sendTelemetryErrorEvent: vi.fn(),
    },
}));

// 动态导入 store（在 mock 之后）
async function importStore() {
    return await import('../utils/pointCaseBindingStore');
}

function setupWorkspace(root: string) {
    mockWorkspaceFolders.length = 0;
    mockWorkspaceFolders.push({ uri: { fsPath: root } });
}

describe('pointCaseBindingStore', () => {
    let tmpRoot: string;

    beforeEach(async () => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-test-'));
        // 目录结构：<root>/测试任务/T1/{测试大纲, 测试案例}
        fs.mkdirSync(path.join(tmpRoot, '测试任务', 'T1', '测试大纲'), { recursive: true });
        fs.mkdirSync(path.join(tmpRoot, '测试任务', 'T1', '测试案例'), { recursive: true });
        setupWorkspace(tmpRoot);
        const store = await importStore();
        store.clearCache(); // 清理 module 级缓存，避免测试间干扰
    });

    afterEach(() => {
        try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    // ==========================================
    // 1:1 语义
    // ==========================================
    it('setPointCases: 传入超过 1 个 case 时抛错', async () => {
        const store = await importStore();
        const p = path.join(tmpRoot, '测试任务/T1/测试大纲/a.md');
        const c1 = path.join(tmpRoot, '测试任务/T1/测试案例/c1.yaml');
        const c2 = path.join(tmpRoot, '测试任务/T1/测试案例/c2.yaml');
        fs.writeFileSync(p, '# a');
        fs.writeFileSync(c1, '');
        fs.writeFileSync(c2, '');
        await expect(store.setPointCases(p, [c1, c2])).rejects.toThrow(/1:1|最多|1 个/);
    });

    it('setPointCases: 目标 case 已被其他 point 占用时抛错', async () => {
        const store = await importStore();
        const pA = path.join(tmpRoot, '测试任务/T1/测试大纲/A.md');
        const pB = path.join(tmpRoot, '测试任务/T1/测试大纲/B.md');
        const c1 = path.join(tmpRoot, '测试任务/T1/测试案例/c1.yaml');
        fs.writeFileSync(pA, ''); fs.writeFileSync(pB, ''); fs.writeFileSync(c1, '');

        await store.setPointCases(pA, [c1]);
        await expect(store.setPointCases(pB, [c1])).rejects.toThrow(/已被其他/);
    });

    it('setPointCases: 空数组等价于解绑', async () => {
        const store = await importStore();
        const p = path.join(tmpRoot, '测试任务/T1/测试大纲/a.md');
        const c1 = path.join(tmpRoot, '测试任务/T1/测试案例/c1.yaml');
        fs.writeFileSync(p, ''); fs.writeFileSync(c1, '');
        await store.setPointCases(p, [c1]);
        expect(store.getCaseOfPoint(p)).toBe(c1);
        await store.setPointCases(p, []);
        expect(store.getCaseOfPoint(p)).toBeNull();
    });

    it('setCasePoints: 目标 point 已绑定其他 case 时抛错', async () => {
        const store = await importStore();
        const p = path.join(tmpRoot, '测试任务/T1/测试大纲/a.md');
        const c1 = path.join(tmpRoot, '测试任务/T1/测试案例/c1.yaml');
        const c2 = path.join(tmpRoot, '测试任务/T1/测试案例/c2.yaml');
        fs.writeFileSync(p, ''); fs.writeFileSync(c1, ''); fs.writeFileSync(c2, '');
        await store.setPointCases(p, [c1]);
        await expect(store.setCasePoints(c2, [p])).rejects.toThrow(/已绑定其他/);
    });

    // ==========================================
    // 双向查询
    // ==========================================
    it('getCaseOfPoint / getPointOfCase 双向可查', async () => {
        const store = await importStore();
        const p = path.join(tmpRoot, '测试任务/T1/测试大纲/a.md');
        const c1 = path.join(tmpRoot, '测试任务/T1/测试案例/c1.yaml');
        fs.writeFileSync(p, ''); fs.writeFileSync(c1, '');
        await store.setPointCases(p, [c1]);
        expect(store.getCaseOfPoint(p)).toBe(c1);
        expect(store.getPointOfCase(c1)).toBe(p);
    });

    it('buildBoundFileMap: point 与 case 均可 O(1) 查表', async () => {
        const store = await importStore();
        const p = path.join(tmpRoot, '测试任务/T1/测试大纲/a.md');
        const c1 = path.join(tmpRoot, '测试任务/T1/测试案例/c1.yaml');
        fs.writeFileSync(p, ''); fs.writeFileSync(c1, '');
        await store.setPointCases(p, [c1]);
        const map = store.buildBoundFileMap(tmpRoot);
        // key 使用 POSIX 绝对路径
        const key = (x: string) => x.replace(/\\/g, '/');
        expect(map.get(key(p))?.role).toBe('point');
        expect(map.get(key(p))?.boundToName).toBe('c1.yaml');
        expect(map.get(key(c1))?.role).toBe('case');
        expect(map.get(key(c1))?.boundToName).toBe('a.md');
    });

    // ==========================================
    // rename / remove 同步
    // ==========================================
    it('renamePathInBindings: point 重命名时绑定引用同步更新', async () => {
        const store = await importStore();
        const p = path.join(tmpRoot, '测试任务/T1/测试大纲/a.md');
        const pNew = path.join(tmpRoot, '测试任务/T1/测试大纲/a-new.md');
        const c1 = path.join(tmpRoot, '测试任务/T1/测试案例/c1.yaml');
        fs.writeFileSync(p, ''); fs.writeFileSync(c1, '');
        await store.setPointCases(p, [c1]);

        // 模拟重命名（磁盘）
        fs.renameSync(p, pNew);
        const changed = await store.renamePathInBindings(p, pNew);
        expect(changed).toBe(true);
        expect(store.getCaseOfPoint(pNew)).toBe(c1);
        expect(store.getPointOfCase(c1)).toBe(pNew);
    });

    it('renamePathInBindings: case 重命名时同步更新', async () => {
        const store = await importStore();
        const p = path.join(tmpRoot, '测试任务/T1/测试大纲/a.md');
        const c1 = path.join(tmpRoot, '测试任务/T1/测试案例/c1.yaml');
        const c1New = path.join(tmpRoot, '测试任务/T1/测试案例/c1-new.yaml');
        fs.writeFileSync(p, ''); fs.writeFileSync(c1, '');
        await store.setPointCases(p, [c1]);

        fs.renameSync(c1, c1New);
        const changed = await store.renamePathInBindings(c1, c1New);
        expect(changed).toBe(true);
        expect(store.getCaseOfPoint(p)).toBe(c1New);
    });

    it('removePathInBindings: 删除 point 时清理整条记录', async () => {
        const store = await importStore();
        const p = path.join(tmpRoot, '测试任务/T1/测试大纲/a.md');
        const c1 = path.join(tmpRoot, '测试任务/T1/测试案例/c1.yaml');
        fs.writeFileSync(p, ''); fs.writeFileSync(c1, '');
        await store.setPointCases(p, [c1]);

        const changed = await store.removePathInBindings(p);
        expect(changed).toBe(true);
        expect(store.getCaseOfPoint(p)).toBeNull();
        expect(store.getPointOfCase(c1)).toBeNull();
    });

    it('removePathInBindings: 删除 case 时从 cases 数组剔除', async () => {
        const store = await importStore();
        const p = path.join(tmpRoot, '测试任务/T1/测试大纲/a.md');
        const c1 = path.join(tmpRoot, '测试任务/T1/测试案例/c1.yaml');
        fs.writeFileSync(p, ''); fs.writeFileSync(c1, '');
        await store.setPointCases(p, [c1]);

        const changed = await store.removePathInBindings(c1);
        expect(changed).toBe(true);
        expect(store.getPointOfCase(c1)).toBeNull();
        // point 记录会因 cases 为空而被删掉
        expect(store.getCaseOfPoint(p)).toBeNull();
    });

    // ==========================================
    // 乐观锁
    // ==========================================
    it('saveBindings: expectedMtimeMs 与磁盘不一致时抛 ConcurrentWriteError', async () => {
        const store = await importStore();
        // 先创建初始文件
        await store.ensureStoreFile(tmpRoot);
        const filePath = store.getStoreFilePath(tmpRoot);
        // 制造一次写入，让磁盘 mtime 更新
        fs.writeFileSync(filePath, JSON.stringify({ version: 1, bindings: [] }, null, 2));
        // 用一个显然过期的 mtime 触发冲突
        await expect(
            store.saveBindings(tmpRoot, { version: 1, bindings: [] }, 0),
        ).rejects.toBeInstanceOf(store.ConcurrentWriteError);
    });
});
