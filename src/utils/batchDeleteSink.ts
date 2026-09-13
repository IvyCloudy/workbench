/**
 * 批量删除埋点相关的"纯数据"类型与聚合器。
 *
 * 拆到独立文件的原因：
 *   1. 单测友好：workspaceListeners.ts 依赖 vscode 全家桶，直接 import 会拉起
 *      整棵 UnifiedEditorProvider 依赖树导致测试环境 crash；
 *   2. 单一职责：sink 是纯内存数据结构，与文件系统 / VS Code API 无耦合。
 *
 * 详细语义参见 workspaceListeners.ts 中 caseFileDelete.batch.file / batch.done 埋点契约。
 */

/** finalizeHardDelete 完成一次 unlink 后回调给上层的观测结果 */
export interface FileUnlinkReport {
    filePath: string;
    /**
     * unlink 归档：
     *   - 'ok'    ：unlink 成功
     *   - 'enoent'：文件已不存在（并发场景，等价成功）
     *   - 'failed'：其他错误码（如 EBUSY / EPERM / EACCES），已被上层 catch
     */
    unlinkResult: 'ok' | 'enoent' | 'failed';
    /** 失败时的错误码（如 EBUSY / EPERM），成功时为空字符串 */
    errorCode: string;
    /** 失败时截断的错误消息，成功时为空字符串 */
    errorMessage: string;
    /** unlink 前该文件字节大小；获取失败返回 -1 */
    fileSize: number;
    /** 是否曾有打开的编辑器 panel（用于分析"关 tab 与 unlink"的时序影响） */
    hadOpenPanel: boolean;
}

/** 批量 per-file 明细单条记录 */
export interface BatchFileRecord {
    filePath: string;
    /** 是否为无需线上、直接真删的文件（hardDeleteOnly 分支，tsId 三档为空） */
    hardDeleteOnly: boolean;
    /** 本文件本次成功的 tsId 明细（type=1 + type=3） */
    syncedTsIds: string[];
    /** 本文件线上真实删除成功的 tsId（type=1） */
    deletedSuccessIds: string[];
    /** 本文件线上本不存在、同步清理的 tsId（type=3） */
    deletedSourceMissingIds: string[];
    /**
     * 文件 unlink 结果：
     *   - 'ok' / 'enoent' / 'failed'：finalizeHardDelete 实际调用 unlink 的三档结果
     *   - 'skipped'：预检失败或同步失败，未真正执行 unlink（文件仍保留）
     *   - 'unknown'：既未预检失败也未走过 unlink 回报（一般不会出现，容错用）
     */
    unlinkResult: 'ok' | 'enoent' | 'failed' | 'skipped' | 'unknown';
    /** unlink 失败错误码，仅 failed 时有值 */
    unlinkErrorCode: string;
    /** unlink 前文件字节大小，-1 表示未获取 */
    fileSize: number;
    /** 是否为预检失败文件（未真正执行删除动作，tsId 三档为空） */
    precheckFailed: boolean;
    /** 预检失败原因（仅 precheckFailed=true 时有值，超长将由上层截断） */
    precheckReason: string;
}

/**
 * 批量删除"per-file 明细"聚合器 —— 让 finalize 在批量场景下把
 * 每个文件的（1）syncResult 三档 tsId，（2）文件 unlink 结果，
 * 分别记录到 per-file 明细里；最终由批量入口：
 *   - `caseFileDelete.batch.done`：一条总览事件（大盘计数用）
 *   - `caseFileDelete.batch.file` ：每个文件一条明细事件（可追溯"哪个 tsId 属于哪个文件"）
 */
export interface BatchSyncedIdsSink {
    /** 追加一个文件的 syncResult 三档 tsId（同时写入总览与 per-file 记录） */
    appendFromSyncResult(filePath: string, sync: { synced: string[]; deletedSuccess: string[]; deletedSourceMissing: string[] }): void;
    /** 标记一个文件为 hardDeleteOnly（tsId 三档为空，但仍需在 per-file 明细里体现） */
    markHardDeleteOnly(filePath: string): void;
    /**
     * 标记一个文件为预检失败：未真正执行删除，tsId 三档为空，unlinkResult='skipped'。
     * 在 batch.file 明细中体现，确保"批量文件清单"完整可回放（含预检失败）。
     */
    markPrecheckFailed(filePath: string, reason: string): void;
    /** 记录 unlink 结果（由 finalizeHardDelete 的 onUnlinkReport 触发） */
    recordUnlink(report: FileUnlinkReport): void;
    /** 快照总览（用于 batch.done 大盘计数） */
    snapshot(): { syncedTsIds: string[]; deletedSuccessIds: string[]; deletedSourceMissingIds: string[] };
    /** 快照 per-file 明细列表（用于 batch.file 逐文件上报） */
    snapshotFiles(): BatchFileRecord[];
}

/** 构造一个批量 tsId 明细聚合器（新的独立实例，避免跨批污染） */
export function createBatchSyncedIdsSink(): BatchSyncedIdsSink {
    // 总览累加（兼容 batch.done）
    const synced: string[] = [];
    const deletedSuccess: string[] = [];
    const deletedSourceMissing: string[] = [];
    // per-file 明细：以 filePath 为 key
    const files = new Map<string, BatchFileRecord>();

    const ensureRecord = (filePath: string): BatchFileRecord => {
        let rec = files.get(filePath);
        if (!rec) {
            rec = {
                filePath,
                hardDeleteOnly: false,
                syncedTsIds: [],
                deletedSuccessIds: [],
                deletedSourceMissingIds: [],
                unlinkResult: 'unknown',
                unlinkErrorCode: '',
                fileSize: -1,
                precheckFailed: false,
                precheckReason: '',
            };
            files.set(filePath, rec);
        }
        return rec;
    };

    return {
        appendFromSyncResult(filePath, sync) {
            const rec = ensureRecord(filePath);
            if (Array.isArray(sync?.synced)) {
                synced.push(...sync.synced);
                rec.syncedTsIds.push(...sync.synced);
            }
            if (Array.isArray(sync?.deletedSuccess)) {
                deletedSuccess.push(...sync.deletedSuccess);
                rec.deletedSuccessIds.push(...sync.deletedSuccess);
            }
            if (Array.isArray(sync?.deletedSourceMissing)) {
                deletedSourceMissing.push(...sync.deletedSourceMissing);
                rec.deletedSourceMissingIds.push(...sync.deletedSourceMissing);
            }
        },
        markHardDeleteOnly(filePath) {
            const rec = ensureRecord(filePath);
            rec.hardDeleteOnly = true;
        },
        markPrecheckFailed(filePath, reason) {
            const rec = ensureRecord(filePath);
            rec.precheckFailed = true;
            // 预检失败即视为"未真正执行 unlink"，统一标 skipped 方便后端筛选
            rec.unlinkResult = 'skipped';
            // 截断超长原因文本，避免后端拉长字段（8000 上限由整体截断兜底，这里就近 500）
            rec.precheckReason = (reason || '').slice(0, 500);
        },
        recordUnlink(report) {
            const rec = ensureRecord(report.filePath);
            rec.unlinkResult = report.unlinkResult;
            rec.unlinkErrorCode = report.errorCode;
            rec.fileSize = report.fileSize;
        },
        snapshot() {
            // 返回浅拷贝，避免外部修改回灌进内部累积状态
            return {
                syncedTsIds: synced.slice(),
                deletedSuccessIds: deletedSuccess.slice(),
                deletedSourceMissingIds: deletedSourceMissing.slice(),
            };
        },
        snapshotFiles() {
            // 保持插入顺序（Map 天然按插入顺序迭代），便于上报时的 fileIndex 稳定
            return Array.from(files.values()).map(r => ({
                ...r,
                syncedTsIds: r.syncedTsIds.slice(),
                deletedSuccessIds: r.deletedSuccessIds.slice(),
                deletedSourceMissingIds: r.deletedSourceMissingIds.slice(),
            }));
        },
    };
}
