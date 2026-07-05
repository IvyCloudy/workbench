/**
 * ============================================================================
 *  services/webviewDataPusher.ts
 *  Webview 数据推送器
 * ----------------------------------------------------------------------------
 *  职责：
 *    从 BaseEditorProvider.resolveCustomEditor 中抽出 pushDataToWebview 的完整逻辑，
 *    专职做「解析文件 → 补全 tracking 列 → 差异比对高亮 → 组装 Data 帧 → 下发 webview」。
 *
 *  设计要点：
 *    1. 通过构造函数注入所需依赖（webview / session / filePath / 日志 / prefetch），
 *       避免像原闭包一样直接捕获 resolveCustomEditor 内的 7+ 变量。
 *    2. filePath 可变（重命名场景）：由外部通过 updateFilePath() 更新，避免闭包老引用。
 *    3. lastSelfSaveAt 状态外置：保存/推送时由外部同步更新；本类只读用于日志。
 *    4. 空 diff 语义、userMarks skip、fallback 回推等原有细节完整保留。
 * ============================================================================
 */
import * as vscode from 'vscode';
import { TextEncoder } from 'util';
import { ensureTrackingColumns } from '../parsers';
import { getFailures } from './../utils/pushFailureStore';
import { getMarks } from './../utils/markStore';
import { getHeaderLabels } from './../utils/headerLabels';
import { applyDiffHighlight, type EditorSession } from './diffHighlight';
import { TelemetryService } from '../utils/telemetry';
import { buildErrorProps } from './utils';

/** 需要触发 diff 高亮的 push 原因集合。集中管理便于扩展与阅读：
 *  - 'init' / 'reload' / 'pushSuccess'：字面量原因；
 *  - 'externalChange:*'：外部变更（fsWatcher / onDidSaveTextDocument）通过前缀命中。
 */
const DIFF_TRIGGER_REASONS = new Set<string>(['init', 'pushSuccess', 'reload']);
const DIFF_TRIGGER_PREFIXES: readonly string[] = ['externalChange:'];
/** 触发 diff 时若结果为空，pushSuccess/reload 需要显式清空前端残留高亮（'null'），
 *  init/externalChange 保持前端已有状态（'undefined'）。 */
const EMPTY_DIFF_NULL_REASONS = new Set<string>(['pushSuccess', 'reload']);
/** saveHighlight / pushSuccess 帧不回推 userMarks，避免覆盖前端最新 mark 状态 */
const SKIP_USERMARKS_REASONS = new Set<string>(['saveHighlight', 'pushSuccess']);

function shouldTriggerDiff(reason: string): boolean {
    if (DIFF_TRIGGER_REASONS.has(reason)) return true;
    return DIFF_TRIGGER_PREFIXES.some(p => reason.startsWith(p));
}

/** 预解析结果类型（与 resolveCustomEditor 中的 prefetchPromise 保持一致） */
export type PrefetchResult = { tableData: any; sourceData: any; generated: boolean } | null;

export interface WebviewDataPusherOptions {
    webviewPanel: vscode.WebviewPanel;
    session: EditorSession;
    /** 首次创建时的文件路径；重命名后请通过 updateFilePath() 更新 */
    filePath: string;
    /** 带前缀/时间戳的日志函数，与外部 log 保持一致 */
    log: (...args: any[]) => void;
    /** 预解析 Promise（init 首帧优先复用），无预解析时可传 null */
    prefetchPromise: Promise<PrefetchResult> | null;
    /** 由外部保存/推送写盘时更新，用于压制 fsWatcher 自反弹 */
    onSelfSave: () => void;
}

/**
 * 编辑器 webview 数据推送器
 *
 * 用法：
 *   const pusher = new WebviewDataPusher({...});
 *   await pusher.push(true, 'init');
 *   pusher.updateFilePath(newPath); // 重命名后
 */
export class WebviewDataPusher {
    private readonly webviewPanel: vscode.WebviewPanel;
    private readonly session: EditorSession;
    private readonly log: (...args: any[]) => void;
    private readonly prefetchPromise: Promise<PrefetchResult> | null;
    private readonly onSelfSave: () => void;
    private filePath: string;

    constructor(opts: WebviewDataPusherOptions) {
        this.webviewPanel = opts.webviewPanel;
        this.session = opts.session;
        this.filePath = opts.filePath;
        this.log = opts.log;
        this.prefetchPromise = opts.prefetchPromise;
        this.onSelfSave = opts.onSelfSave;
    }

    /** 文件重命名后同步更新内部 filePath 引用 */
    updateFilePath(newPath: string): void {
        this.filePath = newPath;
    }

    /** 主入口：解析 → 差异比对 → 组装消息 → postMessage */
    async push(forceReparse: boolean, reason: string, force?: boolean, clearAllMods?: boolean): Promise<void> {
        try {
            if (forceReparse || !this.session.cachedTableData) {
                const shouldContinue = await this.reparseAndDiff(reason, force);
                if (!shouldContinue) return; // 可疑空解析：静默丢弃本次推送，与原实现语义一致
            }
            this.postFullDataMessage(reason, force, clearAllMods);
        } catch (err: any) {
            this.log('❌ push failed:', err?.message || err);
            this.postFallbackData(reason, force);
        }
    }

    /**
     * 重新解析文件、必要时补全 tracking 列并做差异比对高亮。
     * @returns true 表示继续后续 postMessage；false 表示识别到可疑空解析，本次静默跳过。
     */
    private async reparseAndDiff(reason: string, force?: boolean): Promise<boolean> {
        const oldData = this.session.cachedTableData;
        const prevRowsLen = (oldData?.rows || []).length;
        const _parseStart = Date.now();

        // ⚡ init 场景优先复用 prefetch 结果
        let prefetchHit: PrefetchResult = null;
        if (reason === 'init' && this.prefetchPromise) {
            try { prefetchHit = await this.prefetchPromise; } catch (_) { prefetchHit = null; }
        }

        let result: { tableData: any; sourceData: any };
        if (prefetchHit) {
            result = { tableData: prefetchHit.tableData, sourceData: prefetchHit.sourceData };
            this.log('⚡ prefetch hit on init, skip reparse');
        } else {
            result = await this.session.parser.parse(this.filePath);
        }

        const _parseDur = Date.now() - _parseStart;
        const newRowsLen = (result.tableData?.rows || []).length;
        const newColsLen = (result.tableData?.headers || []).length;
        this.log(`🔍 parse done reason=${reason} prevRows=${prevRowsLen} newRows=${newRowsLen} cols=${newColsLen} dur=${_parseDur}ms force=${!!force}`);
        this.log(`📋 headers: [${result.tableData?.headers?.join(', ')}]`);

        // 调试：表头异常时记录文件内容前 500 字符
        if (result.tableData?.headers?.length <= 1) {
            try {
                const content = await require('fs').promises.readFile(this.filePath, 'utf-8');
                this.log(`⚠️ 表头异常！文件内容预览: ${content.slice(0, 500)}`);
            } catch (e: any) {
                this.log(`⚠️ 无法读取文件: ${e?.message}`);
            }
        }

        // 防御：force=true 时若解析为 0 行而旧 cache > 0 行，多半是 fs 未 flush
        if (force && prevRowsLen > 0 && newRowsLen === 0) {
            this.log(`⚠ skip suspicious empty reparse (prev=${prevRowsLen}, reason=${reason}) — likely fs flush midway`);
            return false;
        }

        this.session.originalSourceData = result.sourceData;
        // prefetch 命中时 ensureTrackingColumns 已执行过，无需重复
        const ensured = prefetchHit
            ? { tableData: prefetchHit.tableData, generated: prefetchHit.generated }
            : ensureTrackingColumns(result.tableData, this.session.originalSourceData);
        this.session.cachedTableData = ensured.tableData;

        if (ensured.generated) {
            try {
                this.onSelfSave();
                await this.session.parser.save(this.filePath, this.session.cachedTableData, this.session.originalSourceData);
                this.log('💾 testcase_id 已补全并落盘');
            } catch (e: any) {
                this.log('⚠ testcase_id 落盘失败:', e?.message || e);
                TelemetryService.sendTelemetryErrorEvent('editor.testcaseId.saveFailed',
                    buildErrorProps(e, { fileFormat: this.session.type || '' }));
            }
        }

        // init / 外部变更 / 推送成功 / 重置刷新时做差异比对
        if (shouldTriggerDiff(reason)) {
            const emptyDiffHighlight: 'null' | 'undefined' =
                EMPTY_DIFF_NULL_REASONS.has(reason) ? 'null' : 'undefined';
            await applyDiffHighlight(this.filePath, this.session, ensured.tableData, this.log,
                { logPrefix: `(reason=${reason})`, emptyDiffHighlight });
        }
        return true;
    }

    /** 组装并发送 full-data 消息（正常路径） */
    private postFullDataMessage(reason: string, force?: boolean, clearAllMods?: boolean): void {
        const dataStr = JSON.stringify(this.session.cachedTableData);
        const uint8Array = new TextEncoder().encode(dataStr);
        const rowsLen = (this.session.cachedTableData?.rows || []).length;

        const isExternal = reason.indexOf('externalChange') === 0;
        const highlighted = this.session.highlightedCells;

        const msgPayload: any = {
            type: this.session.type + 'Data',
            data: Array.from(uint8Array),
            force: !!force,
            reason,
            externalChange: isExternal,
            filePath: this.filePath,
        };
        if (highlighted !== undefined) {
            msgPayload.highlightedCells = highlighted;
        }
        if (clearAllMods) {
            msgPayload.clearAllMods = true;
        }

        // 推送失败标记
        try {
            msgPayload.pushFailures = getFailures(this.filePath);
        } catch { /* ignore */ }

        const deleted = this.session.deletedInfos;
        if (deleted !== undefined) msgPayload.deletedInfos = deleted;
        const added = this.session.addedInfos;
        if (added !== undefined) msgPayload.addedInfos = added;

        // saveHighlight / pushSuccess 时跳过 userMarks 回推（webview 已持有最新值）
        if (!SKIP_USERMARKS_REASONS.has(reason)) {
            try { msgPayload.userMarks = getMarks(this.filePath); } catch { /* ignore */ }
        }
        try { msgPayload.headerLabels = getHeaderLabels(); } catch { /* ignore */ }

        // deletedInfos / addedInfos 为一次性字段，发送后清空
        this.session.deletedInfos = undefined;
        this.session.addedInfos = undefined;

        this.log(`📤 push (${reason}) rows=${rowsLen} visible=${this.webviewPanel.visible} force=${!!force} external=${isExternal}`);
        this.webviewPanel.webview.postMessage(msgPayload);
    }

    /** 主流程失败时的兜底：只把已 parse 的 cachedTableData 推给前端，避免前端卡在 loading */
    private postFallbackData(reason: string, force?: boolean): void {
        try {
            if (!this.session.cachedTableData) return;
            const dataStr = JSON.stringify(this.session.cachedTableData);
            const uint8Array = new TextEncoder().encode(dataStr);
            const fallbackPayload: any = {
                type: this.session.type + 'Data',
                data: Array.from(uint8Array),
                force: !!force,
                reason: reason + ':fallback',
                externalChange: false,
                filePath: this.filePath,
            };
            this.log(`📤 push (fallback) rows=${(this.session.cachedTableData.rows || []).length}`);
            this.webviewPanel.webview.postMessage(fallbackPayload);
        } catch (e2: any) {
            this.log('❌ fallback push also failed:', e2?.message || e2);
        }
    }
}