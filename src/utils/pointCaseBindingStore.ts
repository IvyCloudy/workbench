/**
 * ============================================================================
 *  utils/pointCaseBindingStore.ts
 *  测试要点(md/xmind) ↔ 测试案例(csv/yaml/json) 双向绑定持久化
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 维护 <workspace-root>/.plugin/.tms/point-case-bindings.json 文件。
 *    2. 提供绑定关系的读、写、增、删、双向查询接口。
 *    3. 采用「以要点为主键 + cases 数组」的存储结构，支持多对多关系。
 *
 *  设计要点：
 *    - 绑定文件位于**当前工作区**（每个 workspace 独立），路径写入项目内。
 *    - 所有路径使用**相对工作区根**的 POSIX 路径（跨平台稳定）。
 *    - 使用 mtime 缓存避免重复 IO。
 *    - 变更后自动写盘并触发装饰器刷新。
 * ============================================================================
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ============================================
// 类型定义
// ============================================

/** 单条绑定记录：以「要点」为主键 */
export interface PointCaseBinding {
    /** 测试要点文件（相对工作区根的 POSIX 路径），例：测试任务/xxx/测试大纲/登录.md */
    point: string;
    /** 关联的测试案例文件列表（相对路径） */
    cases: string[];
    /** 最近更新时间戳 */
    updatedAt?: number;
}

/** 存储文件顶层结构 */
export interface PointCaseBindingsFile {
    version: number;
    bindings: PointCaseBinding[];
}

// ============================================
// 常量与状态缓存
// ============================================

const STORE_REL_DIR = '.plugin/.tms';
const STORE_FILE_NAME = 'point-case-bindings.json';
const CURRENT_VERSION = 1;

/** 每个工作区根路径 → { filePath, cache, mtimeMs } */
interface CacheEntry {
    filePath: string;
    data: PointCaseBindingsFile;
    mtimeMs: number;
}
const cacheByRoot = new Map<string, CacheEntry>();

// ============================================
// 工具函数
// ============================================

function toPosix(p: string): string {
    return p.replace(/\\/g, '/');
}

/** 获取当前工作区根路径列表 */
export function getWorkspaceRoots(): string[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return [];
    return folders.map(f => toPosix(f.uri.fsPath));
}

/**
 * 根据文件绝对路径找到所在的工作区根。
 * 若不在任何工作区内，返回 null。
 */
export function findWorkspaceRootFor(absPath: string): string | null {
    const p = toPosix(absPath);
    const roots = getWorkspaceRoots();
    // 从最长根优先匹配，避免嵌套 workspace 误判
    const sorted = [...roots].sort((a, b) => b.length - a.length);
    for (const r of sorted) {
        if (p === r || p.startsWith(r + '/')) return r;
    }
    return null;
}

/** 绝对路径 → 相对工作区根的 POSIX 路径 */
export function toRelPath(absPath: string, root?: string): string | null {
    const r = root ?? findWorkspaceRootFor(absPath);
    if (!r) return null;
    const p = toPosix(absPath);
    if (p === r) return '';
    if (!p.startsWith(r + '/')) return null;
    return p.substring(r.length + 1);
}

/** 相对路径 → 绝对路径 */
export function toAbsPath(root: string, relPath: string): string {
    return path.join(root, relPath);
}

/** 获取存储文件路径（不 ensure） */
export function getStoreFilePath(root: string): string {
    return path.join(root, STORE_REL_DIR, STORE_FILE_NAME);
}

function emptyFile(): PointCaseBindingsFile {
    return { version: CURRENT_VERSION, bindings: [] };
}

// ============================================
// 读写核心
// ============================================

/**
 * 确保存储文件存在（不存在则创建空文件与目录）。
 * 返回文件绝对路径。
 */
export async function ensureStoreFile(root: string): Promise<string> {
    const dir = path.join(root, STORE_REL_DIR);
    const filePath = getStoreFilePath(root);
    try {
        await fs.promises.mkdir(dir, { recursive: true });
        try {
            await fs.promises.access(filePath, fs.constants.F_OK);
        } catch {
            await fs.promises.writeFile(filePath, JSON.stringify(emptyFile(), null, 2), 'utf-8');
        }
    } catch (err: any) {
        console.warn('[PointCaseBinding] ensureStoreFile 失败:', err?.message || err);
    }
    return filePath;
}

/**
 * 读取绑定文件（使用 mtime 缓存）。
 * 文件不存在或解析失败时返回空结构。
 */
export function loadBindings(root: string): PointCaseBindingsFile {
    const filePath = getStoreFilePath(root);
    try {
        const stat = fs.statSync(filePath);
        const cached = cacheByRoot.get(root);
        if (cached && cached.filePath === filePath && cached.mtimeMs === stat.mtimeMs) {
            return cached.data;
        }
        const text = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(text);
        let data: PointCaseBindingsFile;
        if (parsed && Array.isArray(parsed.bindings)) {
            data = {
                version: parsed.version || CURRENT_VERSION,
                bindings: parsed.bindings.map((b: any) => ({
                    point: String(b.point || ''),
                    cases: Array.isArray(b.cases) ? b.cases.map((c: any) => String(c)) : [],
                    updatedAt: typeof b.updatedAt === 'number' ? b.updatedAt : undefined,
                })).filter((b: PointCaseBinding) => !!b.point),
            };
        } else {
            data = emptyFile();
        }
        cacheByRoot.set(root, { filePath, data, mtimeMs: stat.mtimeMs });
        return data;
    } catch (err: any) {
        if (err && err.code !== 'ENOENT') {
            console.warn('[PointCaseBinding] loadBindings 失败:', err?.message || err);
        }
        return emptyFile();
    }
}

/**
 * 写入绑定文件（自动创建目录）。
 * 写完后刷新缓存。
 *
 * expectedMtimeMs 用于乐观锁：若提供且当前磁盘 mtime 与之不一致，
 * 说明期间被其它进程/窗口改动，抛出 ConcurrentWriteError 让上层决定重试或提示。
 */
export class ConcurrentWriteError extends Error {
    constructor(msg: string) { super(msg); this.name = 'ConcurrentWriteError'; }
}

export async function saveBindings(root: string, data: PointCaseBindingsFile, expectedMtimeMs?: number): Promise<void> {
    const filePath = await ensureStoreFile(root);
    // 乐观锁：写前重新 stat，与调用者读到的基线对比
    if (typeof expectedMtimeMs === 'number') {
        try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs !== expectedMtimeMs) {
                throw new ConcurrentWriteError('绑定文件已被其它进程改动，请刷新后重试');
            }
        } catch (e) {
            if (e instanceof ConcurrentWriteError) throw e;
            // ENOENT 或其它 → 视为无基线，继续写入
        }
    }
    const normalized: PointCaseBindingsFile = {
        version: CURRENT_VERSION,
        bindings: (data.bindings || [])
            .filter(b => b && b.point)
            .map(b => ({
                point: b.point,
                cases: Array.from(new Set((b.cases || []).filter(Boolean))),
                updatedAt: b.updatedAt ?? Date.now(),
            })),
    };
    await fs.promises.writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf-8');
    try {
        const stat = fs.statSync(filePath);
        cacheByRoot.set(root, { filePath, data: normalized, mtimeMs: stat.mtimeMs });
    } catch { /* ignore */ }
}

/** 读取绑定文件的同时返回当前磁盘 mtime（用于乐观锁基线）。
 *  若文件不存在，会先 ensureStoreFile 建空文件，让基线 mtime 与后续 saveBindings 检查值一致。
 */
export async function loadBindingsWithMtime(root: string): Promise<{ data: PointCaseBindingsFile; mtimeMs: number }> {
    const filePath = getStoreFilePath(root);
    try {
        await fs.promises.access(filePath, fs.constants.F_OK);
    } catch {
        await ensureStoreFile(root);
    }
    const data = loadBindings(root);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch { /* ignore */ }
    return { data, mtimeMs };
}

/** 清除某工作区的缓存（供外部监听器调用） */
export function clearCache(root?: string): void {
    if (root) cacheByRoot.delete(root);
    else cacheByRoot.clear();
    // 同步失效装饰器的全局映射（避免装饰器读到过时数据）
    invalidateGlobalBoundFileMap();
}

// ============================================
// 业务查询接口（对外）
// ============================================

/**
 * 获取某个测试要点(md/xmind)已绑定的测试案例列表（返回绝对路径）
 */
export function getBoundCasesOfPoint(pointAbsPath: string): string[] {
    const root = findWorkspaceRootFor(pointAbsPath);
    if (!root) return [];
    const rel = toRelPath(pointAbsPath, root);
    if (!rel) return [];
    const data = loadBindings(root);
    const record = data.bindings.find(b => b.point === rel);
    if (!record) return [];
    return record.cases.map(c => toAbsPath(root, c));
}

/**
 * 获取某个测试案例(csv/yaml/json)已绑定的测试要点列表（返回绝对路径）
 */
export function getBoundPointsOfCase(caseAbsPath: string): string[] {
    const root = findWorkspaceRootFor(caseAbsPath);
    if (!root) return [];
    const rel = toRelPath(caseAbsPath, root);
    if (!rel) return [];
    const data = loadBindings(root);
    const results: string[] = [];
    for (const b of data.bindings) {
        if (b.cases.includes(rel)) {
            results.push(toAbsPath(root, b.point));
        }
    }
    return results;
}

/**
 * 判断某个绝对路径的文件是否已参与任何绑定（作为要点或案例任一角色）。
 */
export function isPathBound(absPath: string): boolean {
    const root = findWorkspaceRootFor(absPath);
    if (!root) return false;
    const rel = toRelPath(absPath, root);
    if (!rel) return false;
    const data = loadBindings(root);
    for (const b of data.bindings) {
        if (b.point === rel) return b.cases.length > 0;
        if (b.cases.includes(rel)) return true;
    }
    return false;
}

/**
 * 覆盖式设置：将某个测试要点的关联案例列表设为 caseAbsPaths（覆盖旧绑定）。
 * 传空数组等价于解绑该要点的所有案例。
 *
 * **1:1 语义**：
 *   - 允许传入的 caseAbsPaths 长度为 0 或 1；超过 1 抛错。
 *   - 若传入的 case 已被其他 point 占用，抛错。
 */
export async function setPointCases(pointAbsPath: string, caseAbsPaths: string[]): Promise<void> {
    const root = findWorkspaceRootFor(pointAbsPath);
    if (!root) throw new Error('文件不在任何已打开的工作区内');
    const rel = toRelPath(pointAbsPath, root);
    if (!rel) throw new Error('无法解析测试要点的相对路径');

    if (caseAbsPaths.length > 1) {
        throw new Error('测试要点与测试案例为 1:1 关系，最多只能绑定 1 个测试案例');
    }

    // 过滤：只保留位于同一工作区的案例路径
    const caseRels: string[] = [];
    for (const c of caseAbsPaths) {
        const cRoot = findWorkspaceRootFor(c);
        if (cRoot !== root) continue;
        const cr = toRelPath(c, root);
        if (cr) caseRels.push(cr);
    }

    const { data, mtimeMs } = await loadBindingsWithMtime(root);

    // 1:1 占用校验：若目标 case 已被其他 point 占用，则拒绝
    for (const cr of caseRels) {
        const occupier = data.bindings.find(b => b.point !== rel && b.cases.includes(cr));
        if (occupier) {
            throw new Error(`该测试案例已被其他测试要点绑定：${occupier.point}`);
        }
    }

    const idx = data.bindings.findIndex(b => b.point === rel);
    if (idx === -1) {
        if (caseRels.length > 0) {
            data.bindings.push({ point: rel, cases: caseRels, updatedAt: Date.now() });
        }
    } else {
        if (caseRels.length === 0) {
            data.bindings.splice(idx, 1);
        } else {
            data.bindings[idx].cases = caseRels;
            data.bindings[idx].updatedAt = Date.now();
        }
    }
    await saveBindings(root, data, mtimeMs);
    invalidateGlobalBoundFileMap();
}

/**
 * 覆盖式设置：将某个测试案例的关联要点列表设为 pointAbsPaths（覆盖旧绑定）。
 * 内部会更新多个 point 记录：
 *   - 对每一个原本包含此 case 但不在新列表中的 point，从其 cases 中移除；
 *   - 对新列表中每一个 point，若不含此 case 则加入。
 *
 * **1:1 语义**：
 *   - 允许传入的 pointAbsPaths 长度为 0 或 1；超过 1 抛错。
 *   - 若传入的 point 已绑定其它 case（且不是当前这个），抛错。
 */
export async function setCasePoints(caseAbsPath: string, pointAbsPaths: string[]): Promise<void> {
    const root = findWorkspaceRootFor(caseAbsPath);
    if (!root) throw new Error('文件不在任何已打开的工作区内');
    const caseRel = toRelPath(caseAbsPath, root);
    if (!caseRel) throw new Error('无法解析测试案例的相对路径');

    if (pointAbsPaths.length > 1) {
        throw new Error('测试案例与测试要点为 1:1 关系，最多只能绑定 1 个测试要点');
    }

    const newPointRels: string[] = [];
    for (const p of pointAbsPaths) {
        const pRoot = findWorkspaceRootFor(p);
        if (pRoot !== root) continue;
        const pr = toRelPath(p, root);
        if (pr) newPointRels.push(pr);
    }

    const { data, mtimeMs } = await loadBindingsWithMtime(root);

    // 1:1 占用校验：若目标 point 已经绑定了其它非空 case（且不是当前 caseRel），则拒绝
    for (const pr of newPointRels) {
        const existing = data.bindings.find(b => b.point === pr);
        if (existing && existing.cases.length > 0 && !existing.cases.includes(caseRel)) {
            throw new Error(`该测试要点已绑定其他测试案例：${existing.cases[0]}`);
        }
    }

    // 从旧的所有绑定里剔除该 case
    for (const b of data.bindings) {
        const before = b.cases.length;
        b.cases = b.cases.filter(c => c !== caseRel);
        if (b.cases.length !== before) b.updatedAt = Date.now();
    }
    // 加到新目标 point 上
    for (const pointRel of newPointRels) {
        let record = data.bindings.find(b => b.point === pointRel);
        if (!record) {
            record = { point: pointRel, cases: [], updatedAt: Date.now() };
            data.bindings.push(record);
        }
        if (!record.cases.includes(caseRel)) {
            record.cases.push(caseRel);
            record.updatedAt = Date.now();
        }
    }
    // 清理空 point 记录
    data.bindings = data.bindings.filter(b => b.cases.length > 0);
    await saveBindings(root, data, mtimeMs);
    invalidateGlobalBoundFileMap();
}

/**
 * 【1:1 语义】获取某个测试要点绑定的唯一测试案例（绝对路径），未绑定返回 null。
 */
export function getCaseOfPoint(pointAbsPath: string): string | null {
    const list = getBoundCasesOfPoint(pointAbsPath);
    return list.length > 0 ? list[0] : null;
}

/**
 * 【1:1 语义】获取某个测试案例绑定的唯一测试要点（绝对路径），未绑定返回 null。
 */
export function getPointOfCase(caseAbsPath: string): string | null {
    const list = getBoundPointsOfCase(caseAbsPath);
    return list.length > 0 ? list[0] : null;
}

/**
 * 【1:1 语义】给定工作区，返回:
 *   caseRel(POSIX) → 占用它的 pointRel
 * 供 UI 展示"某 case 已被 X 绑定"信息。
 */
export function buildCaseOccupancyMap(root: string): Map<string, string> {
    const data = loadBindings(root);
    const m = new Map<string, string>();
    for (const b of data.bindings) {
        if (!b.point) continue;
        for (const c of b.cases) {
            if (!m.has(c)) m.set(c, b.point); // 若历史上有重复，只保留第一个
        }
    }
    return m;
}

/**
 * 【1:1 语义】给定工作区，返回:
 *   pointRel(POSIX) → 该 point 唯一绑定的 caseRel（若无则不存在于 map 中）
 */
export function buildPointOccupancyMap(root: string): Map<string, string> {
    const data = loadBindings(root);
    const m = new Map<string, string>();
    for (const b of data.bindings) {
        if (!b.point || b.cases.length === 0) continue;
        m.set(b.point, b.cases[0]);
    }
    return m;
}

/**
 * 【装饰器高性能路径】构建"某工作区所有已绑定文件"的绝对路径 → 元信息映射，
 * 供 provideFileDecoration O(1) 查询。value 中区分角色：
 *   role='point'  → 该文件是要点，boundToRel 是其绑定的案例相对路径
 *   role='case'   → 该文件是案例，boundToRel 是其绑定的要点相对路径
 */
export interface BoundFileMeta {
    role: 'point' | 'case';
    /** 对端相对路径 */
    boundToRel: string;
    /** 对端文件名（用于 tooltip 展示） */
    boundToName: string;
}

export function buildBoundFileMap(root: string): Map<string, BoundFileMeta> {
    const data = loadBindings(root);
    const m = new Map<string, BoundFileMeta>();
    for (const b of data.bindings) {
        if (!b.point || b.cases.length === 0) continue;
        const caseRel = b.cases[0]; // 1:1
        const pointAbs = toAbsPath(root, b.point);
        const caseAbs = toAbsPath(root, caseRel);
        m.set(toPosix(pointAbs), {
            role: 'point',
            boundToRel: caseRel,
            boundToName: path.basename(caseRel),
        });
        m.set(toPosix(caseAbs), {
            role: 'case',
            boundToRel: b.point,
            boundToName: path.basename(b.point),
        });
    }
    return m;
}

/**
 * 全工作区聚合的 O(1) 装饰器映射（跨多个 workspaceFolder）。
 * key: POSIX 绝对路径。
 */
let globalBoundFileMapCache: { data: Map<string, BoundFileMeta>; builtAt: number } | null = null;
const GLOBAL_MAP_TTL_MS = 5_000; // 装饰器高频调用，用短 TTL 削峰

export function getGlobalBoundFileMap(force = false): Map<string, BoundFileMeta> {
    const now = Date.now();
    if (!force && globalBoundFileMapCache && (now - globalBoundFileMapCache.builtAt) < GLOBAL_MAP_TTL_MS) {
        return globalBoundFileMapCache.data;
    }
    const merged = new Map<string, BoundFileMeta>();
    for (const r of getWorkspaceRoots()) {
        const m = buildBoundFileMap(r);
        for (const [k, v] of m.entries()) merged.set(k, v);
    }
    globalBoundFileMapCache = { data: merged, builtAt: now };
    return merged;
}

export function invalidateGlobalBoundFileMap(): void {
    globalBoundFileMapCache = null;
}

/**
 * 返回该工作区内所有涉及绑定的文件路径集合（绝对路径），供装饰器批量刷新。
 */
export function getAllBoundFilePaths(root: string): string[] {
    const data = loadBindings(root);
    const set = new Set<string>();
    for (const b of data.bindings) {
        if (b.cases.length === 0) continue;
        set.add(toAbsPath(root, b.point));
        for (const c of b.cases) set.add(toAbsPath(root, c));
    }
    return Array.from(set);
}

// ============================================
// 文件级增量维护接口（供 workspace 监听器调用）
// ============================================

/**
 * 文件重命名/移动时同步更新绑定库。
 * 若旧路径出现在 point 或 cases 中，一并替换成新相对路径。
 * 返回是否实际修改了绑定库。
 */
export async function renamePathInBindings(oldAbs: string, newAbs: string): Promise<boolean> {
    const oldRoot = findWorkspaceRootFor(oldAbs);
    const newRoot = findWorkspaceRootFor(newAbs);
    if (!oldRoot) return false;
    // 允许跨工作区移动？为简单起见，若新旧不同 root 视为删除+新增（当前实现：仅在同一 root 时更新）
    if (newRoot !== oldRoot) {
        // 视为删除
        return removePathInBindings(oldAbs);
    }
    const oldRel = toRelPath(oldAbs, oldRoot);
    const newRel = toRelPath(newAbs, oldRoot);
    if (!oldRel || !newRel || oldRel === newRel) return false;

    const { data, mtimeMs } = await loadBindingsWithMtime(oldRoot);
    let changed = false;
    for (const b of data.bindings) {
        if (b.point === oldRel) {
            b.point = newRel;
            b.updatedAt = Date.now();
            changed = true;
        }
        const idx = b.cases.indexOf(oldRel);
        if (idx !== -1) {
            b.cases[idx] = newRel;
            b.updatedAt = Date.now();
            changed = true;
        }
    }
    if (!changed) return false;
    try {
        await saveBindings(oldRoot, data, mtimeMs);
    } catch (e: any) {
        // 冲突时重试一次（不用乐观锁基线）
        if (e && e.name === 'ConcurrentWriteError') {
            await saveBindings(oldRoot, data);
        } else {
            throw e;
        }
    }
    invalidateGlobalBoundFileMap();
    return true;
}

/**
 * 文件被删除时同步清理绑定库中所有引用。
 * 返回是否实际修改了绑定库。
 */
export async function removePathInBindings(absPath: string): Promise<boolean> {
    const root = findWorkspaceRootFor(absPath);
    if (!root) return false;
    const rel = toRelPath(absPath, root);
    if (!rel) return false;

    const { data, mtimeMs } = await loadBindingsWithMtime(root);
    let changed = false;
    // 1) 删掉所有 point === rel 的整条记录
    const before1 = data.bindings.length;
    data.bindings = data.bindings.filter(b => b.point !== rel);
    if (data.bindings.length !== before1) changed = true;
    // 2) 从 cases 中剔除
    for (const b of data.bindings) {
        const before2 = b.cases.length;
        b.cases = b.cases.filter(c => c !== rel);
        if (b.cases.length !== before2) {
            b.updatedAt = Date.now();
            changed = true;
        }
    }
    // 3) 清空 cases 的 point 记录一并删除
    const before3 = data.bindings.length;
    data.bindings = data.bindings.filter(b => b.cases.length > 0);
    if (data.bindings.length !== before3) changed = true;

    if (!changed) return false;
    try {
        await saveBindings(root, data, mtimeMs);
    } catch (e: any) {
        if (e && e.name === 'ConcurrentWriteError') {
            await saveBindings(root, data);
        } else {
            throw e;
        }
    }
    invalidateGlobalBoundFileMap();
    return true;
}

/**
 * 初始化：确保所有已打开工作区的存储文件均已就绪。
 */
export async function ensureAllWorkspaceStores(): Promise<void> {
    const roots = getWorkspaceRoots();
    await Promise.all(roots.map(r => ensureStoreFile(r).catch(() => {})));
}
