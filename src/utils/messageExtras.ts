/**
 * ============================================================================
 *  utils/messageExtras.ts  ——  聚合入口（barrel）
 * ----------------------------------------------------------------------------
 *  本文件在 2026-09-13 拆分为 4 个内聚子模块，本入口仅做 re-export，
 *  外部 import 路径（`from './messageExtras'`）保持零改动：
 *
 *    · modalShared.ts               —— HTML 转义 / 通用样式 / 结果类兜底
 *    · deleteConfirmModal.ts        —— 单文件删除确认（含表格版 + 简化版）
 *    · batchDeleteConfirmModal.ts   —— 多文件批量删除·聚合确认
 *    · deleteResultModal.ts         —— 删除结果 + 后端 API 错误提示
 *
 *  依赖方向（受控循环引用保持不变）：
 *    - message.ts 依赖 modalShared 的 escapeHtml_ / baseModalCss_ /
 *      formatFailures_ / showResultErrorModal_ / showResultModalFallback_。
 *    - modalShared / deleteResultModal 依赖 message.ts 的 showModal / showToast
 *      （仅运行时调用，模块顶层不执行）。
 *    ESM 下函数绑定可安全前向引用，与拆分前保持一致。
 *
 *  维护约定：
 *    - 新增业务能力请直接落到对应子模块，并在此追加 re-export；
 *    - 除非有明确理由，不要往本 barrel 里加入实际逻辑。
 * ============================================================================
 */

// —— 通用弹窗共享工具（供 message.ts 使用；业务侧一般无需直接引用） ——
export {
    escapeHtml_,
    baseModalCss_,
    formatFailures_,
    showResultErrorModal_,
    showResultModalFallback_,
} from './modalShared';

// —— 单文件删除确认弹窗 ——
export { showDeleteConfirmModal, showDeleteConfirmSimpleModal } from './deleteConfirmModal';
export type { DeleteConfirmItem } from './deleteConfirmModal';

// —— 多文件批量删除·聚合确认弹窗 ——
export { showBatchDeleteConfirmModal } from './batchDeleteConfirmModal';
export type { BatchDeleteFileEntry } from './batchDeleteConfirmModal';

// —— 删除结果 + 后端 API 错误提示 ——
export { showApiError, showDeleteResult } from './deleteResultModal';