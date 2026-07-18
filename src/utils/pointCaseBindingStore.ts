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
 */
export async function saveBindings(root: string, data: PointCaseBindingsFile): Promise<void> {
    const filePath = await ensureStoreFile(root);
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

/** 清除某工作区的缓存（供外部监听器调用） */
export function clearCache(root?: string): void {
    if (root) cacheByRoot.delete(root);
    else cacheByRoot.clear();
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

    const data = loadBindings(root);

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
    await saveBindings(root, data);
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

    const data = loadBindings(root);

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
    await saveBindings(root, data);
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

/**
 * 初始化：确保所有已打开工作区的存储文件均已就绪。
 */
export async function ensureAllWorkspaceStores(): Promise<void> {
    const roots = getWorkspaceRoots();
    await Promise.all(roots.map(r => ensureStoreFile(r).catch(() => {})));
}
