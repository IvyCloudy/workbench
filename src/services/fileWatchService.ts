/**
 * ============================================================================
 *  services/fileWatchService.ts
 *  单文件外部变更监听器
 * ----------------------------------------------------------------------------
 *  职责：
 *    从 BaseEditorProvider.resolveCustomEditor 中抽出「监听文件外部变更」的完整逻辑：
 *      - fsWatcher.onDidChange / onDidCreate（覆盖 VSCode 内/外的所有写入）
 *      - workspace.onDidSaveTextDocument（补充 TextEditor 保存场景）
 *      - 自保存守护窗口（避免 parser.save 触发的 fsWatcher 自反弹）
 *      - 150ms 去抖（合并短时间内的多次变更）
 *    统一把「有效外部变更」通过 onExternalChange 回调抛给上层。
 *
 *  设计要点：
 *    - filePath 可变（重命名场景）：由外部通过 updateFilePath() 更新监听目标；
 *    - 上层只需关心业务动作，无需再重复写「回声忽略 + 埋点 + 去抖」样板；
 *    - dispose() 集中释放三条订阅 + 一条 timer，避免遗漏泄漏。
 * ============================================================================
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { TelemetryService } from '../utils/telemetry';

/** 上游触发外部变更时携带的 origin 标签，用于日志与埋点区分事件源 */
export type ExternalChangeOrigin =
    | 'fsWatcher'
    | 'fsWatcher:create'
    | 'onDidSaveTextDocument';

export interface FileWatchServiceOptions {
    /** 监听的文件绝对路径（重命名后请通过 updateFilePath() 更新） */
    filePath: string;
    /** session.type，仅用于埋点/日志 */
    fileFormat: string;
    /** 带前缀/时间戳的日志函数 */
    log: (...args: any[]) => void;
    /**
     * 自保存时间戳读取器（外部维护 lastSelfSaveAt）：
     * 该窗口内的变更被识别为自我反弹，直接忽略。
     */
    getLastSelfSaveAt: () => number;
    /** 自保存守护窗口毫秒数 */
    selfSaveGuardMs: number;
    /** 有效外部变更（已过守护窗口 & 已完成防抖）时回调，实参为 origin 标签 */
    onExternalChange: (origin: ExternalChangeOrigin) => void;
    /** 防抖时长，默认 150ms */
    debounceMs?: number;
}

/**
 * 用法：
 *   const svc = new FileWatchService({...});
 *   // 重命名后：svc.updateFilePath(newPath);
 *   // 卸载时：  svc.dispose();
 */
export class FileWatchService {
    private readonly opts: FileWatchServiceOptions;
    private readonly debounceMs: number;
    private watcher: vscode.FileSystemWatcher | null = null;
    private disposables: vscode.Disposable[] = [];
    private debounceTimer: NodeJS.Timeout | null = null;
    /** 最近一次待触发的 origin，供防抖窗口结束时使用 */
    private pendingOrigin: ExternalChangeOrigin | null = null;
    private currentPath: string;

    constructor(opts: FileWatchServiceOptions) {
        this.opts = opts;
        this.debounceMs = opts.debounceMs ?? 150;
        this.currentPath = opts.filePath;
        this.attachWatcher(this.currentPath);
        this.attachDocSaveSub();
    }

    /**
     * 更新监听目标文件路径（用于文件重命名后同步监听）。
     * 若路径未变，则不做任何操作。
     */
    updateFilePath(newPath: string): void {
        if (this.currentPath === newPath) return;
        this.currentPath = newPath;
        // fsWatcher 是按 pattern 建立的，路径变了必须重建；saveDoc 订阅是全局的，无需重建（内部按路径过滤）
        this.detachWatcher();
        this.attachWatcher(newPath);
    }

    /** 释放所有资源（三条订阅 + timer） */
    dispose(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.detachWatcher();
        this.disposables.forEach(d => { try { d.dispose(); } catch (_) { /* ignore */ } });
        this.disposables = [];
    }

    /** ============== 内部实现 ============== */

    private attachWatcher(filePath: string): void {
        const w = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(path.dirname(filePath), path.basename(filePath))
        );
        this.watcher = w;
        this.disposables.push(w);
        this.disposables.push(w.onDidChange(() => this.handleChange('fsWatcher')));
        this.disposables.push(w.onDidCreate(() => this.handleChange('fsWatcher:create')));
    }

    private detachWatcher(): void {
        if (!this.watcher) return;
        // 由 disposables 数组统一 dispose，这里只清引用，防止 updateFilePath 后 dispose() 二次释放
        try { this.watcher.dispose(); } catch (_) { /* ignore */ }
        this.watcher = null;
    }

    private attachDocSaveSub(): void {
        this.disposables.push(vscode.workspace.onDidSaveTextDocument((doc) => {
            try {
                if (doc && doc.uri.fsPath === this.currentPath) {
                    this.handleChange('onDidSaveTextDocument');
                }
            } catch (_) { /* ignore */ }
        }));
    }

    /** 统一入口：先做自保存守护判定，再走去抖，最后回调上层 */
    private handleChange(origin: ExternalChangeOrigin): void {
        const now = Date.now();
        const lastSelfSaveAt = this.opts.getLastSelfSaveAt();
        const sinceSelfSave = lastSelfSaveAt ? (now - lastSelfSaveAt) : -1;

        // 自身刚刚 save 完短时间内的回声：直接忽略
        if (lastSelfSaveAt && sinceSelfSave < this.opts.selfSaveGuardMs) {
            TelemetryService.sendTelemetryEvent('editor.externalChange.skipped',
                { origin, fileFormat: this.opts.fileFormat });
            this.opts.log(`🔁 ignore self-save echo (${origin}) sinceSelfSave=${sinceSelfSave}ms < ${this.opts.selfSaveGuardMs}ms`);
            return;
        }

        this.opts.log(`📥 external change scheduled (${origin}) sinceSelfSave=${sinceSelfSave}ms`);
        this.pendingOrigin = origin;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            const firedOrigin = this.pendingOrigin ?? origin;
            this.pendingOrigin = null;
            TelemetryService.sendTelemetryEvent('editor.externalChange.fired',
                { origin: firedOrigin, fileFormat: this.opts.fileFormat });
            this.opts.log(`📥 external change fired (${firedOrigin}), reload`);
            try {
                this.opts.onExternalChange(firedOrigin);
            } catch (e: any) {
                this.opts.log('❌ onExternalChange callback failed:', e?.message || e);
            }
        }, this.debounceMs);
    }
}
