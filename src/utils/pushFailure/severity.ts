/**
 * 失败项 severity 的统一归一化入口。
 *
 * 约定：缺省 / 非 'warn' 一律按 'error'（硬阻断）处理，与既有 `x || 'error'`
 * 及 `(x || 'error') !== 'warn'` 的口径完全等价；集中一处避免各模块各写一份兜底。
 */
export type FailureSeverity = 'error' | 'warn';

export function normalizeSeverity(severity: unknown): FailureSeverity {
    return severity === 'warn' ? 'warn' : 'error';
}
