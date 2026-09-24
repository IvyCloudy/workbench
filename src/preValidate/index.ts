/**
 * preValidate/index.ts
 * -------------------------------------------------------------
 * 前置校验模块 · 对外统一出口（barrel）
 * -------------------------------------------------------------
 * 使用建议：新代码请从 '../preValidate' 或 './preValidate' 引用，
 * 老路径 'handlers/pushCore.stages' / 'utils/preValidateGate' /
 * 'handlers/editValidationHandler' 仍会通过 re-export 保持兼容，但已 @deprecated。
 */

// —— 纯校验层 ——
export {
    readTsId,
    isTestcaseIdValid,
    DEFAULT_VALIDATORS,
    runValidators,
    runValidatorsOnRowsPure,
    collectPlaceholderTestcaseIdFailures,
    collectEmptyTestcaseIdFailures,
    collectInvalidFormatFailures,
} from './validators';
export type { RowValidator } from './validators';

// —— 推送编排层 ——
export {
    stampRowIndex,
    stepPreValidate,
    applyPreValidationDrops,
    pickAllDroppedReason,
} from './stepPreValidate';

// —— 门控（扩展端 ↔ webview）——
export { openPreValidateGate, resolvePreValidateGate } from './preValidateGate';

// —— 编辑期主动校验 ——
export {
    requestEditValidation,
    registerEditValidation,
    triggerEditValidationOnWebviewOpen,
    setSuppressEditValidationPrompt,
} from './editValidationHandler';
