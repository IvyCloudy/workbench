/**
 * ============================================================================
 *  utils/pushFailureStore.ts
 *  推送失败标记的持久化存储
 * ----------------------------------------------------------------------------
 *  职责：
 *    1. 以 globalStorageUri/push-failures.json 作为持久化文件。
 *    2. 每项以文件绝对路径为 key，记录 { [tsId: string]: reason }。
 *       仅按 testcase_id（行稳定唯一标识）维护失败映射，不依赖行号。
 *    3. 文件不存在时自动创建空对象模板。
 *    4. 提供 getFailures / mergeFailures / clearFailures 接口。
 *  设计要点：
 *    - 使用 globalStorageUri，与 highlighted-cells.json 同目录，跨工作区共享。
 *    - 推送返回时增量合并：本批参与的 tsId 全部清掉旧标记，再写入本次失败 tsId+reason。
 *    - 文件打开时从磁盘加载，关闭/重开/重启 vscode 后失败高亮不丢失。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TS_ID_COLUMN } from '../services/utils';
import type { PushFailCategory, PushInterfaceField } from './pushFailureCategory';
import type { PushSubField } from '../handlers/pushCore.types';

// ============================================
// 类型定义
// ============================================

/**
 * B4 · 字段细粒度定位单元：与 fields[i] 平行（fieldCells[i]）。
 * - stepIdx / subField 均为 undefined 时表示“无细粒度定位（整列）”（前端回退到旧代整列高亮）。
 * - 同一 field 允许多次出现（如同行多步命中），以 (field, stepIdx, subField) 三元组去重。
 */
export interface PushFailureFieldCell {
    stepIdx?: number;
    subField?: PushSubField;
}

/** 单条失败记录：reason 为失败原因原文，timestamp 为失败时间戳（ms），category/fields 为分类与字段维度 */
export interface PushFailureItem {
    reason: string;
    timestamp: number;
    /** 失败分类码（统计/埋点维度），历史数据缺失时为 undefined */
    category?: PushFailCategory;
    /**
     * 命中的接口字段码列表（聚焦维度）。
     * B3 单元格级高亮改造后升级为数组，支持同一 tsId 命中多个字段时一次性染色。
     * 历史数据缺失或为空数组时视为「无字段维度」，前端渲染兜底染 tsId 列。
     */
    fields?: PushInterfaceField[];
    /**
     * B3 · 字段级 severity（与 fields 数组一一对应）：
     * 同一 tsId 内 error/warn 字段并存时，前端可按具体字段独立染色（error 列红、warn 列黄）。
     * 长度必须等于 fields.length；读盘时若缺失或长度不一致，会用行级 severity 补齐。
     */
    fieldSeverities?: Array<'error' | 'warn'>;
    /**
     * B4 · 字段细粒度定位数组（与 fields 平行，一一对应）：
     *   - fields[i] = 'description' 且 fieldCells[i] = { stepIdx: 1, subField: 'operation' }
     *     → 代表“第 2 步的步骤名称”命中（展开态子表格 sub-td 高亮、dv2 弹窗输入框高亮）
     *   - fieldCells[i] = { }（空对象）或未定义 → 无细粒度定位，前端回退到“整列高亮”
     * 旧快照无该字段时读盘直接作为缺失处理（不影响高亮仅退化为整列）。
     */
    fieldCells?: PushFailureFieldCell[];
    /**
     * B5 · 字段级独立 reason（与 fields 数组一一对应）：
     *   同一 tsId 内多个字段命中时，每个字段可携带自己的失败原因，供前端 hover
     *   "只显示该单元格的问题"（而非整行合并 reason）。长度必须等于 fields.length；
     *   读盘时若缺失或长度不一致，会用行级 reason 补齐（保持向后兼容）。
     */
    fieldReasons?: string[];
    /**
     * @deprecated 旧字段，保留仅用于向后兼容读取。写入统一走 fields。
     */
    field?: PushInterfaceField;
    /**
     * 行级严重级别（B3 引入）：
     *   - 'error'（默认）：该行至少有一个 error 字段 → 行号左侧竖条显示红色
     *   - 'warn'          ：该行仅命中 warn 字段（软拦截）→ 行号左侧竖条显示黄色
     * 与 fieldSeverities 的关系：行级 severity 取 fieldSeverities 中的最严重值（error > warn）。
     */
    severity?: 'error' | 'warn';
}

export interface PushFailureEntry {
    [tsId: string]: PushFailureItem; // tsId -> { reason, timestamp }
}

interface PushFailureStoreData {
    [filePath: string]: PushFailureEntry;
}

// ============================================
// 内部状态
// ============================================

let resolvedFilePath: string | null = null;
let cachedStore: PushFailureStoreData | null = null;
let cachedMtimeMs = 0;

/**
 * 旧格式兼容：早期版本 entry value 为纯字符串 reason，
 * 新版升级为 { reason, timestamp } 对象。读取时统一规范化，
 * 旧格式 timestamp 视为 0（最旧），渲染时不会"晚于"任何用户标记。
 */
function normalizeEntry(raw: any): PushFailureEntry {
    const out: PushFailureEntry = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const k of Object.keys(raw)) {
        const v = raw[k];
        if (v == null) continue;
        if (typeof v === 'string') {
            out[k] = { reason: v, timestamp: 0 };
        } else if (typeof v === 'object') {
            const reason = (v.reason != null) ? String(v.reason) : '';
            const ts = (typeof v.timestamp === 'number' && isFinite(v.timestamp)) ? v.timestamp : 0;
            const cat = typeof v.category === 'string' ? (v.category as PushFailCategory) : undefined;
            // fields 数组优先（新格式）；不存在则读旧 field 字符串并包成单元素数组
            let fieldsArr: PushInterfaceField[] | undefined;
            if (Array.isArray(v.fields)) {
                const cleaned: PushInterfaceField[] = [];
                for (const f of v.fields) {
                    if (typeof f === 'string' && f && cleaned.indexOf(f as PushInterfaceField) < 0) {
                        cleaned.push(f as PushInterfaceField);
                    }
                }
                if (cleaned.length > 0) fieldsArr = cleaned;
            } else if (typeof v.field === 'string' && v.field) {
                fieldsArr = [v.field as PushInterfaceField];
            }
            const sev = (v.severity === 'warn' || v.severity === 'error') ? (v.severity as 'error' | 'warn') : undefined;
            // fieldSeverities：新格式（与 fields 一一对应）；旧盘缺失时用行级 severity 逐位补齐
            let fieldSevArr: Array<'error' | 'warn'> | undefined;
            if (fieldsArr && fieldsArr.length > 0) {
                const src = Array.isArray(v.fieldSeverities) ? v.fieldSeverities : [];
                fieldSevArr = fieldsArr.map((_f, i) => {
                    const s = src[i];
                    if (s === 'warn' || s === 'error') return s as 'error' | 'warn';
                    return sev || 'error';
                });
            }
            // B4 · fieldCells：与 fields 一一对应。旧盘无该字段时补与 fields 同长的空对象数组，
            //   避免前端因长度不齐而投失败。
            let fieldCellsArr: PushFailureFieldCell[] | undefined;
            if (fieldsArr && fieldsArr.length > 0) {
                const srcCells = Array.isArray(v.fieldCells) ? v.fieldCells : [];
                fieldCellsArr = fieldsArr.map((_f, i) => {
                    const c = srcCells[i];
                    if (c && typeof c === 'object') {
                        const stepIdx = (typeof c.stepIdx === 'number' && isFinite(c.stepIdx) && c.stepIdx >= 0) ? c.stepIdx : undefined;
                        const subField = (typeof c.subField === 'string' && c.subField) ? (c.subField as PushSubField) : undefined;
                        return { stepIdx, subField };
                    }
                    return {};
                });
            }
            // B5 · fieldReasons：与 fields 一一对应；旧盘缺失时用行级 reason 逐位补齐，
            //   保证前端「按字段查 reason」总能拿到一条可读的原因。
            let fieldReasonsArr: string[] | undefined;
            if (fieldsArr && fieldsArr.length > 0) {
                const srcReasons = Array.isArray(v.fieldReasons) ? v.fieldReasons : [];
                fieldReasonsArr = fieldsArr.map((_f, i) => {
                    const r = srcReasons[i];
                    if (typeof r === 'string' && r) return r;
                    return reason; // 兜底用行级 reason（旧盘唯一可用来源）
                });
            }
            out[k] = { reason, timestamp: ts, category: cat, fields: fieldsArr, fieldSeverities: fieldSevArr, fieldCells: fieldCellsArr, fieldReasons: fieldReasonsArr, severity: sev };
        }
    }
    return out;
}

// ============================================
// 公共接口
// ============================================

/**
 * 初始化失败存储文件（必要时创建目录与空对象文件）。
 * 在 activate 阶段调用一次。
 */
export async function ensurePushFailureFile(context: vscode.ExtensionContext): Promise<string> {
    const dir = context.globalStorageUri.fsPath;
    const filePath = path.join(dir, 'push-failures.json');
    resolvedFilePath = filePath;

    try {
        await fs.promises.mkdir(dir, { recursive: true });
        try {
            await fs.promises.access(filePath, fs.constants.F_OK);
        } catch {
            await fs.promises.writeFile(filePath, JSON.stringify({}, null, 2), 'utf-8');
            console.log('[PushFailureStore] 已创建空失败文件: ' + filePath);
        }
    } catch (err: any) {
        console.error('[PushFailureStore] 初始化失败文件失败:', err?.message || err);
    }
    return filePath;
}

/**
 * 读取并缓存失败数据。使用 mtime 校验，文件未变更时直接返回缓存。
 */
function loadStore(): PushFailureStoreData {
    if (!resolvedFilePath) return {};
    try {
        const stat = fs.statSync(resolvedFilePath);
        if (cachedStore && stat.mtimeMs === cachedMtimeMs) {
            return cachedStore;
        }
        const text = fs.readFileSync(resolvedFilePath, 'utf-8');
        const parsed = JSON.parse(text);
        if (typeof parsed !== 'object' || Array.isArray(parsed) || !parsed) {
            console.warn('[PushFailureStore] 文件格式异常，返回空');
            cachedStore = {};
        } else {
            // 兼容旧格式：每个文件下的 entry 内若 value 仍是字符串，统一升级为对象
            const normalized: PushFailureStoreData = {};
            for (const fp of Object.keys(parsed as any)) {
                normalized[fp] = normalizeEntry((parsed as any)[fp]);
            }
            cachedStore = normalized;
        }
        cachedMtimeMs = stat.mtimeMs;
        return cachedStore;
    } catch (err: any) {
        if (err && err.code !== 'ENOENT') {
            console.warn('[PushFailureStore] 读取失败:', err?.message || err);
        }
        return {};
    }
}

/**
 * 持久化写入，同时更新缓存。
 */
async function saveStore(store: PushFailureStoreData): Promise<void> {
    if (!resolvedFilePath) return;
    try {
        const text = JSON.stringify(store, null, 2);
        await fs.promises.writeFile(resolvedFilePath, text, 'utf-8');
        cachedStore = store;
        try {
            const stat = fs.statSync(resolvedFilePath);
            cachedMtimeMs = stat.mtimeMs;
        } catch { /* ignore */ }
    } catch (err: any) {
        console.error('[PushFailureStore] 保存失败:', err?.message || err);
    }
}

/**
 * 查询指定文件的失败映射（tsId → { reason, timestamp }）。无记录返回空对象。
 */
export function getFailures(filePath: string): PushFailureEntry {
    if (!filePath) return {};
    const store = loadStore();
    const entry = store[filePath];
    return entry && typeof entry === 'object' ? entry : {};
}

/**
 * 合并写入：先清除"本批参与的 tsId"的旧失败标记，再写入本次失败 tsId→{reason,timestamp}。
 *   - batchTsIds：本次推送参与的所有 tsId（用于差集，让本批中已成功的 tsId 清掉旧失败标记）
 *   - failures：本次失败的 tsId→reason 映射（reason 为字符串，时间戳由本函数统一打 Date.now()）
 *   - successTsIds：扩展端额外回传的明确成功 tsId（兜底，可为空）
 *
 * 未参与本批的历史失败标记保持不变。
 */
/**
 * 删除指定文件的全部推送失败记录（文件被删除时调用）。
 */
export async function removeFailureFile(filePath: string): Promise<void> {
    if (!filePath) return;
    const store = loadStore();
    if (store[filePath]) {
        delete store[filePath];
        await saveStore(store);
    }
}

/**
 * 清理已不存在的文件的孤儿推送失败记录。
 * 使用异步 fs.promises.access 替代同步 existsSync，避免大量文件时阻塞事件循环。
 */
export async function cleanupOrphanedFailures(): Promise<void> {
    const store = loadStore();
    let changed = false;
    for (const fp of Object.keys(store)) {
        try {
            await fs.promises.access(fp, fs.constants.F_OK);
        } catch {
            delete store[fp];
            changed = true;
        }
    }
    if (changed) await saveStore(store);
}

export async function mergeFailures(
    filePath: string,
    batchTsIds: string[],
    failures: { [tsId: string]: string | { reason: string; category?: PushFailCategory; field?: PushInterfaceField; severity?: 'error' | 'warn'; stepIdx?: number; subField?: PushSubField; fieldReason?: string } },
    successTsIds?: string[]
): Promise<void> {
    // 行级 severity 提升辅助：error > warn > undefined
    const bumpRowSeverity = (a?: 'error' | 'warn', b?: 'error' | 'warn'): 'error' | 'warn' | undefined => {
        if (a === 'error' || b === 'error') return 'error';
        if (a === 'warn' || b === 'warn') return 'warn';
        return undefined;
    };
    if (!filePath) return;
    const store = loadStore();
    const entry: PushFailureEntry = { ...(store[filePath] || {}) };

    // 1) 本批参与 tsId：先清旧标记
    if (Array.isArray(batchTsIds)) {
        for (const t of batchTsIds) {
            if (t !== undefined && t !== null && t !== '') {
                delete entry[String(t)];
            }
        }
    }
    // 2) 扩展端明确成功的 tsId：兜底清除
    if (Array.isArray(successTsIds)) {
        for (const t of successTsIds) {
            if (t !== undefined && t !== null && t !== '') {
                delete entry[String(t)];
            }
        }
    }
    // 3) 写入本次失败：统一打当前时间戳；同 tsId 多条 failure 合并（不再后写覆盖）
    //    - severity 取「最严重」：error > warn
    //    - fields   去重合并
    //    - reason   去重后用「；」拼接
    //    - category 保留首次写入（历史统计口径）
    const now = Date.now();
    if (failures && typeof failures === 'object') {
        for (const k of Object.keys(failures)) {
            const raw = failures[k];
            if (!k || raw === undefined || raw === null) continue;
            const inReason = typeof raw === 'string' ? String(raw) : String(raw.reason || '');
            const inCategory = typeof raw === 'string' ? undefined : (raw.category as PushFailCategory | undefined);
            const inField = typeof raw === 'string' ? undefined : (raw.field as PushInterfaceField | undefined);
            const inSeverity = typeof raw === 'string'
                ? undefined
                : (raw.severity === 'warn' || raw.severity === 'error' ? raw.severity : undefined);
            // B4 · 细粒度定位：仅当 stepIdx 为非负整数时才采用；subField 为可选
            const inStepIdx = (typeof raw === 'string')
                ? undefined
                : ((typeof raw.stepIdx === 'number' && isFinite(raw.stepIdx) && raw.stepIdx >= 0) ? raw.stepIdx : undefined);
            const inSubField = (typeof raw === 'string')
                ? undefined
                : ((typeof raw.subField === 'string' && raw.subField) ? raw.subField : undefined);
            const inCell: PushFailureFieldCell = { stepIdx: inStepIdx, subField: inSubField };
            // B5 · 字段级 reason：优先取显式 fieldReason（多字段合并时调用方传入单条 reason）；
            //   否则回退到 inReason（单字段命中时可直接当 fieldReason 使用）。
            const inFieldReason: string = (typeof raw === 'string')
                ? inReason
                : (typeof raw.fieldReason === 'string' && raw.fieldReason ? raw.fieldReason : inReason);

            const existing = entry[k];
            if (!existing) {
                entry[k] = {
                    reason: inReason,
                    timestamp: now,
                    category: inCategory,
                    fields: inField ? [inField] : undefined,
                    fieldSeverities: inField ? [inSeverity || 'error'] : undefined,
                    fieldCells: inField ? [inCell] : undefined,
                    fieldReasons: inField ? [inFieldReason] : undefined,
                    severity: inSeverity,
                };
                continue;
            }
            // 合并：行级 severity 提升（error 压 warn），用于行号竖条颜色
            const mergedRowSeverity = bumpRowSeverity(existing.severity, inSeverity);
            // 合并：fields 数组以 (field, stepIdx, subField) 三元组去重；
            //   同三元组命中时 fieldSeverities 对应位做「error 压 warn」提升。
            //   不同 stepIdx/subField 的相同 field 属于不同单元格，保留为多个数组元素。
            const mergedFields: PushInterfaceField[] = Array.isArray(existing.fields) ? existing.fields.slice() : [];
            const mergedFieldSev: Array<'error' | 'warn'> = Array.isArray(existing.fieldSeverities)
                ? existing.fieldSeverities.slice()
                : mergedFields.map(() => existing.severity || 'error');
            const mergedFieldCells: PushFailureFieldCell[] = Array.isArray(existing.fieldCells)
                ? existing.fieldCells.slice()
                : mergedFields.map(() => ({}));
            // B5 · fieldReasons：与 fields 平行。旧盘无时先用行级 reason 补齐，
            //   本次 merge 新入时再按位覆盖。
            const mergedFieldReasons: string[] = Array.isArray(existing.fieldReasons)
                ? existing.fieldReasons.slice()
                : mergedFields.map(() => existing.reason || '');
            // 兜底对齐长度（防御旧盘：fields 有但 fieldSeverities / fieldCells / fieldReasons 缺）
            while (mergedFieldSev.length < mergedFields.length) mergedFieldSev.push(existing.severity || 'error');
            while (mergedFieldCells.length < mergedFields.length) mergedFieldCells.push({});
            while (mergedFieldReasons.length < mergedFields.length) mergedFieldReasons.push(existing.reason || '');
            if (inField) {
                // 以 (field, stepIdx, subField) 三元组定位现有位（nullish 相等也视为同一个，避免同一 cell 重复写入）
                let fi = -1;
                for (let m = 0; m < mergedFields.length; m++) {
                    if (mergedFields[m] !== inField) continue;
                    const c = mergedFieldCells[m] || {};
                    if ((c.stepIdx ?? undefined) === inStepIdx && (c.subField ?? undefined) === inSubField) { fi = m; break; }
                }
                if (fi < 0) {
                    mergedFields.push(inField);
                    mergedFieldSev.push(inSeverity || 'error');
                    mergedFieldCells.push(inCell);
                    mergedFieldReasons.push(inFieldReason);
                } else {
                    // 同三元组再次命中：severity 取更严重
                    const bumped = bumpRowSeverity(mergedFieldSev[fi], inSeverity) || mergedFieldSev[fi];
                    if (bumped === 'error' || bumped === 'warn') mergedFieldSev[fi] = bumped;
                    // B5 · reason：同位新入若非空则覆盖（error 压 warn 时同步拿新原因；
                    //   相同 severity 重复命中时也以新原因为准，旧日志无需保留）。
                    if (inFieldReason) mergedFieldReasons[fi] = inFieldReason;
                }
            }
            // 合并：reason 拼接去重
            const parts = existing.reason ? existing.reason.split('；') : [];
            if (inReason && parts.indexOf(inReason) < 0) parts.push(inReason);
            const mergedReason = parts.filter(s => !!s).join('；');
            entry[k] = {
                reason: mergedReason,
                timestamp: now,
                category: existing.category || inCategory,
                fields: mergedFields.length > 0 ? mergedFields : undefined,
                fieldSeverities: mergedFields.length > 0 ? mergedFieldSev : undefined,
                fieldCells: mergedFields.length > 0 ? mergedFieldCells : undefined,
                fieldReasons: mergedFields.length > 0 ? mergedFieldReasons : undefined,
                severity: mergedRowSeverity,
            };
        }
    }

    if (Object.keys(entry).length === 0) {
        // 整个文件无失败标记，移除该 key 保持文件精简
        if (store[filePath]) {
            delete store[filePath];
            await saveStore(store);
        }
        return;
    }
    store[filePath] = entry;
    await saveStore(store);
}

/**
 * 便捷方法：从推送数据行和失败列表构造 mergeFailures 所需参数并持久化。
 * 消除 pushHandler / BaseEditorProvider 中完全重复的 batchTsIds/failuresMap/successTsIds 整理逻辑。
 *
 * @param filePath        文件路径
 * @param rows            参与推送的行数据数组
 * @param failures        失败项列表（来自 parsePushResponse）
 * @param successMappings 成功项列表（来自 parsePushResponse）
 */
export async function persistPushFailures(
    filePath: string,
    rows: any[],
    failures: Array<{ tsId: string; reason: string; category?: PushFailCategory; field?: PushInterfaceField; severity?: 'error' | 'warn'; stepIdx?: number; subField?: PushSubField; hits?: Array<{ field?: PushInterfaceField; stepIdx?: number; subField?: PushSubField }> }>,
    successMappings: Array<{ tsId: string; testCaseNo: string }>,
): Promise<void> {
    const batchTsIds: string[] = [];
    for (const rec of rows) {
        const id = rec && (rec as any)[TS_ID_COLUMN] != null ? String((rec as any)[TS_ID_COLUMN]) : '';
        if (id) batchTsIds.push(id);
    }
    // B3 修复：同 tsId 多条 failure 需要"合并全部字段/严重度/原因"，
    //   而非"后写覆盖"（历史 bug：enumInvalid+todoPlaceholder 同行时 warn 吃掉 error）。
    //   这里在传入 mergeFailures 之前先做 pre-merge：把每个 tsId 的多条汇总为一个对象，
    //   然后利用 mergeFailures 内部的合并逻辑与已有磁盘记录再合并。
    interface AggItem {
        reasons: string[];
        categoryFirst?: PushFailCategory;
        fields: PushInterfaceField[];
        /** 与 fields 一一对应的字段级 severity（error/warn）——用于前端按字段独立染色 */
        fieldSeverities: Array<'error' | 'warn'>;
        /** B4 · 与 fields 一一对应的字段细粒度定位（未命中细粒度则为空对象） */
        fieldCells: PushFailureFieldCell[];
        /** B5 · 与 fields 一一对应的字段级独立 reason（供前端 hover 时只显示该单元格自己的原因） */
        fieldReasons: string[];
        /** 行级 severity（fieldSeverities 中最严重值）——用于行号竖条颜色 */
        severity?: 'error' | 'warn';
    }
    const agg: { [tsId: string]: AggItem } = {};
    failures.forEach(f => {
        if (!f || f.tsId === undefined || f.tsId === null || f.tsId === '') return;
        const key = String(f.tsId);
        const bucket = agg[key] || (agg[key] = { reasons: [], fields: [], fieldSeverities: [], fieldCells: [], fieldReasons: [] });
        const r = String(f.reason || '');
        if (r && bucket.reasons.indexOf(r) < 0) bucket.reasons.push(r);
        if (!bucket.categoryFirst && f.category) bucket.categoryFirst = f.category;
        const fSev: 'error' | 'warn' = (f.severity === 'warn') ? 'warn' : 'error';
        // B4 · 若 PushFailureItem 携带 hits[]（checkMulti 聚合形态），按每个 hit 独立累加位置；
        //   否则退化为单点累加（保持向后兼容）。
        //   B5 · fieldReason：优先取 hit.singleReason（同行多字段 checkMulti 时可为每个位置提供细粒度原因），
        //   否则回退到 f.reason（单字段命中 / 同行共享原因时）。
        const positions: Array<{ field?: PushInterfaceField; stepIdx?: number; subField?: PushSubField; singleReason?: string }> =
            Array.isArray(f.hits) && f.hits.length > 0
                ? f.hits.map(h => ({ field: h.field ?? f.field, stepIdx: h.stepIdx, subField: h.subField, singleReason: (h as any).singleReason }))
                : [{ field: f.field, stepIdx: f.stepIdx, subField: f.subField }];
        for (const pos of positions) {
            // B4 · 结构化 (field, stepIdx, subField) 三元组：同三元组同行多次命中仅保留一个
            const inStepIdx = (typeof pos.stepIdx === 'number' && isFinite(pos.stepIdx) && pos.stepIdx >= 0) ? pos.stepIdx : undefined;
            const inSubField = (typeof pos.subField === 'string' && pos.subField) ? pos.subField : undefined;
            const posReason = (typeof pos.singleReason === 'string' && pos.singleReason) ? pos.singleReason : r;
            if (pos.field) {
                let idx = -1;
                for (let m = 0; m < bucket.fields.length; m++) {
                    if (bucket.fields[m] !== pos.field) continue;
                    const c = bucket.fieldCells[m] || {};
                    if ((c.stepIdx ?? undefined) === inStepIdx && (c.subField ?? undefined) === inSubField) { idx = m; break; }
                }
                if (idx < 0) {
                    bucket.fields.push(pos.field);
                    bucket.fieldSeverities.push(fSev);
                    bucket.fieldCells.push({ stepIdx: inStepIdx, subField: inSubField });
                    bucket.fieldReasons.push(posReason);
                } else {
                    // 同三元组多次命中：error 压 warn；reason 若新入非空则覆盖（以新为准）
                    if (fSev === 'error') bucket.fieldSeverities[idx] = 'error';
                    if (posReason) bucket.fieldReasons[idx] = posReason;
                }
            }
        }
        // 行级 severity 取最严重：error > warn
        if (f.severity === 'error' || bucket.severity === 'error') bucket.severity = 'error';
        else if (f.severity === 'warn' || bucket.severity === 'warn') bucket.severity = 'warn';
    });
    // 转成 mergeFailures 期望的入参形态（每 tsId 单条，字段仍走 field 单值传递；
    //   多字段时先通过循环调用 mergeFailures 二次合并 —— 或者在下面直接分批传）。
    // 为简化实现：把 fields 数组"逐条"注入 failuresMap，通过多次 mergeFailures 调用
    //   触发内部 severity/fields/fieldCells 合并逻辑。
    const failuresMap: { [tsId: string]: { reason: string; category?: PushFailCategory; field?: PushInterfaceField; severity?: 'error' | 'warn'; stepIdx?: number; subField?: PushSubField; fieldReason?: string } } = {};
    Object.keys(agg).forEach(tsId => {
        const b = agg[tsId];
        failuresMap[tsId] = {
            reason: b.reasons.join('；'),
            category: b.categoryFirst,
            // 首字段作为 field 传入（保持 mergeFailures 原有单值签名不破坏），
            //   多余字段稍后通过增量 merge 补齐
            field: b.fields[0],
            // 关键：字段级 severity —— 首字段用自己的 severity 而非行级 severity，
            //   保证前端按字段独立染色时 error/warn 语义准确
            severity: b.fieldSeverities[0] || b.severity,
            // B4 · 字段细粒度定位：首字段携带自己的 stepIdx/subField
            stepIdx: b.fieldCells[0]?.stepIdx,
            subField: b.fieldCells[0]?.subField,
            // B5 · 字段级独立 reason：首字段携带自己的 reason（而非合并后的 reasons.join）
            fieldReason: b.fieldReasons[0] || b.reasons[0] || '',
        };
    });
    const successTsIds: string[] = successMappings
        .map(s => s && s.tsId)
        .filter((t: any) => t !== undefined && t !== null && t !== '')
        .map((t: any) => String(t));
    await mergeFailures(filePath, batchTsIds, failuresMap, successTsIds);

    // 补齐多字段：mergeFailures 内部按"新入 field/stepIdx/subField 与已存 fields 合并去重"，
    //   所以对同 tsId 剩余字段进行二次以上的 merge 调用即可把 fields 累积起来。
    //   注意：这里的 batchTsIds 传空数组，避免再次清盘；successTsIds 也传空避免误清。
    const extraRounds: Array<{ [tsId: string]: { reason: string; field: PushInterfaceField; severity: 'error' | 'warn'; stepIdx?: number; subField?: PushSubField; fieldReason?: string } }> = [];
    Object.keys(agg).forEach(tsId => {
        const b = agg[tsId];
        const restFields = b.fields.slice(1);
        const restSev = b.fieldSeverities.slice(1);
        const restCells = b.fieldCells.slice(1);
        const restReasons = b.fieldReasons.slice(1);
        for (let i = 0; i < restFields.length; i++) {
            if (!extraRounds[i]) extraRounds[i] = {};
            extraRounds[i][tsId] = {
                reason: '',
                field: restFields[i],
                // 关键：每个补齐字段带自己的 severity（error/warn），mergeFailures 内会更新对应位置
                severity: restSev[i] || 'error',
                // B4 · 同时携带细粒度定位，以 (field, stepIdx, subField) 三元组去重
                stepIdx: restCells[i]?.stepIdx,
                subField: restCells[i]?.subField,
                // B5 · 字段级独立 reason：每个补齐字段带自己的 reason
                fieldReason: restReasons[i] || '',
            };
        }
    });
    for (const round of extraRounds) {
        if (round && Object.keys(round).length > 0) {
            await mergeFailures(filePath, [], round, []);
        }
    }
}

/**
 * 清除指定文件的所有失败记录（如行整批撤销/文件重建场景）。
 */
export async function clearFailures(filePath: string): Promise<void> {
    if (!filePath) return;
    const store = loadStore();
    if (store[filePath]) {
        delete store[filePath];
        await saveStore(store);
    }
}
