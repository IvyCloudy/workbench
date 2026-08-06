/**
 * pushCore 公共类型定义。
 * 原 pushCore.ts 的「类型定义」段，独立成模块便于子模块间共享而不形成环依赖。
 */

import type * as vscode from 'vscode';
import type { FileParser } from '../parsers';
import type { PushFailCategory, PushInterfaceField } from '../utils/pushFailureCategory';

/** 校验/过滤阶段的输入行结构（只需 TS_ID_COLUMN 字段） */
export type RowLike = Record<string, any>;

/**
 * 推送核心 hooks —— UI 反馈全部收敛于此，本文件不直接调用 showXxx / postMessage。
 * 调用方按场景各自实现：右键推送走独立 webview 弹窗，编辑器推送走当前 panel 内嵌弹窗。
 */
export interface PushCoreHooks {
    /** 未绑定任务 */
    onUnbound: () => void;
    /**
     * 拉取任务信息时抛出异常（网络抖动 / 后端 5xx 等）。
     * 未实现时会降级走 onBackendError；调用方可实现以给出更精准的文案。
     */
    onTaskInfoFailed?: (errorMsg: string) => void;
    /** 文件无数据（仅右键推送场景使用；编辑器推送场景忽略即可） */
    onNoData?: () => void;
    /**
     * 命中占位 TESTCASE_ID —— 弹窗展示 & 通知前端解锁 UI。
     * @deprecated 自 v?.? 起，占位行改为"标记失败 + 从 payload 剔除"，
     *             失败信息会随其他行的推送结果一起在 onComplete 中输出，
     *             该 hook 不再由 runPush 触发。保留仅用于向后兼容外部实现。
     */
    onPlaceholderTestcaseId: (failures: PushFailureItem[]) => void;
    /**
     * testcase_id 为空的行 —— 弹窗展示 & 通知前端解锁 UI。
     * @deprecated 自 v?.? 起，空 tsId 行改为"标记失败 + 从 payload 剔除"，
     *             失败信息随其他行的推送结果一起在 onComplete 中输出，该 hook 不再触发。
     *             未实现时会降级复用 onPlaceholderTestcaseId（历史行为，保持类型兼容）。
     */
    onEmptyTestcaseId?: (failures: PushFailureItem[]) => void;
    /** 全部行为样例数据 —— 弹窗展示 & 通知前端解锁 UI */
    onOnlySampleRows: (failures: PushFailureItem[]) => void;
    /** 后端 returnCode 非成功 —— 弹窗展示错误信息 & 通知前端解锁 UI */
    onBackendError: (errorMsg: string) => void;
    /**
     * runPush 顶层未捕获异常兜底。所有下游 hooks 都不会再触发。
     * 未实现时会降级走 onBackendError；主要作用是让前端解锁按钮 loading。
     */
    onUnexpectedError?: (errorMsg: string) => void;
    /**
     * 成功回写 testCaseNo 到原文件失败时的兜底通知。
     * 用户已经看到"推送成功 N 条"，但文件里的 testCaseNo 未写入 —— 需要显式提示，
     * 否则用户下次再推送同批行会重复创建案例。
     */
    onWriteBackFailed?: (errorMsg: string) => void;
    /**
     * 单次推送行数超过上限（RunPushOptions.maxRows，默认 5000）时的提示。
     * 未实现时会降级走 onBackendError；主要作用是让前端给出"请分批推送"的引导。
     */
    onExceedMaxRows?: (payload: { rows: number; limit: number; message: string }) => void;
    /**
     * 关键阶段进度反馈（可选）。用于让调用方在耗时较长的推送流程中给出用户反馈：
     *   - 'start'        —— 校验通过，即将调用后端
     *   - 'pushing'      —— 已发出后端请求
     *   - 'writingBack'  —— 后端返回成功，正在写盘 testCaseNo
     *   - 'done'         —— 全部结束（成功/部分成功/全部失败均会触发）
     * 未实现即可（无副作用）。
     */
    onProgress?: (stage: 'start' | 'pushing' | 'writingBack' | 'done', payload?: { rows?: number }) => void;
    /**
     * 推送完成（成功/部分成功/全部失败）—— 弹窗展示结果
     *
     * skipped：本次推送中被识别为"样例/模板占位"而主动过滤的行数（不参与后端接口调用）。
     *   - total = successCount + failures.length + skipped
     *   - 弹窗层需要显式展示 skipped，避免出现"总计 13 / 成功 12 / 失败 0"这种
     *     视觉上对不齐的场景（真实差额就是 skipped）。
     *   - 未过滤到样例时为 0；调用方按需读取，缺省视作 0。
     */
    onComplete: (payload: {
        successCount: number;
        failures: PushFailureItem[];
        total: number;
        skipped?: number;
        /** 预校验（占位/空/格式）拦截的行数，与「接口实推失败」区分，便于埋点下钻 */
        preValidationFailCount?: number;
        /** 本次推送链路追踪 ID（与 .complete / .aborted 同源），供批量场景逐文件回传 */
        traceId?: string;
        /** 本次推送耗时（ms），供批量场景逐文件回传，对齐单文件 .complete 的 costMs */
        costMs?: number;
    }) => void;
    /**
     * 成功回写 testCaseNo 前后的钩子。用于编辑器场景标记 self-save 时间戳
     * 防止 fsWatcher 在 pushSuccess 刷新期间覆盖高亮状态；右键场景无需实现。
     */
    markSelfSave?: () => void;
    /**
     * 成功回写完成后的钩子。
     * - 编辑器场景：清空高亮 / 刷新 webview（当无失败时）；
     * - 右键场景：无需实现。
     */
    afterWriteBack?: (context: {
        parsedTableData: any;
        parsedSourceData: any;
        hasFailure: boolean;
    }) => Promise<void>;
    /**
     * 全部推送失败时的快照/高亮兜底钩子（仅编辑器场景需要）。
     * 右键推送不管前端高亮状态，可不实现。
     */
    onAllFailedSnapshot?: (context: {
        parsedTableData: any;
        parsedSourceData: any;
    }) => Promise<void>;
}

/** runPush 入参。 */
export interface RunPushOptions {
    /** 扩展上下文（pushTestCase 需要） */
    extensionContext: vscode.ExtensionContext;
    /** 目标文件路径 */
    filePath: string;
    /** 待推送的行数据（右键=整表；编辑器=选中子集且已用文件源覆盖显示文本） */
    rows: RowLike[];
    /**
     * 下标 → 主表 1-based 行号 解析函数。校验/过滤阶段共用。
     * - 右键推送：`i => i + 1`
     * - 编辑器推送：`i => pushIndexToRow[i] ?? (i + 1)`
     */
    resolveRowIndex: (i: number) => number;
    /** 前端下发的 tsId → 主表行号映射（编辑器场景使用；右键场景可不传） */
    frontRowIndexMap?: Record<string, number>;
    /** 前端下发的 payload 下标 → 主表行号映射（编辑器场景使用；右键场景可不传） */
    frontPushIndexToRow?: number[];
    /** 是否复用外部 parser（编辑器场景）；不传则内部按 fileType 自建（右键场景） */
    parser?: FileParser;
    /** 埋点前缀：'explorerPush' | 'editorPush' */
    telemetryPrefix: string;
    /**
     * 是否跳过 runPush 自身发出的 `.complete` 结局埋点。
     * 批量推送（`handleFilePush` 多文件分支）下为 true：逐文件结果改由
     * `explorerPush.batch.fileResult` + 批次 `explorerPush.batch.done` 统一上报，
     * 避免与单文件 `.complete` 重复计数。单文件推送保持 false（照常发 `.complete`）。
     */
    skipCompleteTelemetry?: boolean;
    /**
     * 单次推送行数上限。超过时短路，不发出后端请求。默认 5000。
     * 主要用于防御用户误操作（例如全选一个 10w 行的文件）导致后端超时/雪崩。
     */
    maxRows?: number;
    /** UI 反馈钩子 */
    hooks: PushCoreHooks;
}

/** runPush 内部状态。用类型收敛"跨 step 共享"的字段，避免大函数里满地飞的局部变量。 */
export interface PushContext {
    readonly opts: RunPushOptions;
    readonly baseName: string;
    readonly fileExt: string;
    readonly pushStart: number;
    readonly traceId: string;
    readonly maxRows: number;
    readonly telemetryPrefix: string;
    readonly hooks: PushCoreHooks;
}

/** 推送失败明细项（送给 showPushResult 弹窗渲染） */
export interface PushFailureItem {
    tsId: string;
    reason: string;
    /** 主表 1-based 行号；undefined 时前端渲染为"(无)"不可点击 */
    rowIndex?: number;
    /** 失败分类码（统计/埋点维度；展示仍用 reason 原文） */
    category?: PushFailCategory;
    /** 命中的接口字段码（聚焦维度；字段类错误才有值，其余为 undefined） */
    field?: PushInterfaceField;
}

/**
 * 成功回写选项。两个入口的差异：
 *  - 右键推送：不复用外部 parser，从头 detectFileType + createParser；无 markSelfSave / afterWriteBack 需求
 *  - 编辑器推送：复用调用方注入的 parser（session.parser）；markSelfSave 前后包一层，
 *    afterWriteBack 处理清空高亮/刷新 webview
 *
 * 快照更新策略：两条路径统一全量刷新（见 writeBackTestCaseNos 内注释），
 * 不再区分「增量 vs 全量」，也不再需要向 savePushSnapshot 传 pushedTsIds。
 */
export interface WriteBackOptions {
    filePath: string;
    successMappings: import('../utils/pushResponse').PushSuccessMapping[];
    /** 若为 undefined，函数内部会 detectFileType + createParser 自建（用于右键推送） */
    parser?: FileParser;
    hooks?: Pick<PushCoreHooks, 'markSelfSave' | 'afterWriteBack' | 'onWriteBackFailed'>;
    hasFailure: boolean;
    /** 用于埋点错误上下文的额外字段（如 ext） */
    telemetryContext: Record<string, string>;
    telemetryPrefix: string;
}

/** 阶段 2 结果：样例过滤产出。 */
export interface ExtractSampleRowsResult {
    filtered: RowLike[];
    sampleFailures: PushFailureItem[];
    skipped: number;
    filteredToOriginal: number[];
}

/** 阶段 4：失败行号解析责任链上下文 —— 各 resolver 只读；由 buildFailureItems 一次组装。 */
export interface RowIndexResolveCtx {
    failure: import('../utils/pushResponse').PushResponseFailure;
    frontRowIndexMap: Record<string, number>;
    frontPushIndexToRow: number[];
    filteredToOriginal: number[];
    tsIdToRowIndex: Map<string, number>;
}

/** 任务信息拉取结果：区分"未绑定" / "异常" / "成功" 三种状态。 */
export type ResolveTaskInfoResult =
    | { status: 'ok'; taskInfo: { testTaskNo: string; subTestTaskId: string } }
    | { status: 'unbound' }
    | { status: 'error'; errorMessage: string; error: unknown };

/** 阶段 2 结果：预校验产出。 */
export interface PreValidationResult {
    /** 预校验失败明细（占位 + 空 + 格式，按此顺序） */
    failures: PushFailureItem[];
    /** 需要从 payload 剔除的原始下标集合 */
    droppedIndex: Set<number>;
    /** 分桶明细（用于差异化埋点） */
    byKind: Record<string, PushFailureItem[]>;
}
