/**
 * ============================================================================
 *  utils/yamlInterceptorState.ts
 *  YAML 前置拦截器共享状态
 * ----------------------------------------------------------------------------
 *  背景：
 *    extension.ts 中的 `registerYamlPreOpenInterceptor` 会在 tab 打开事件里
 *    完成"YAML 语法错误检测 + close CustomEditor tab + 打开文本编辑器并定位
 *    光标 + 弹 Toast"这一完整链路。
 *
 *    但极端时序下（例如 tab 事件早于扩展 activate、或 VS Code 已经把
 *    resolveCustomEditor 调度到 microtask），`BaseEditorProvider.resolveCustomEditor`
 *    的兜底切换逻辑也可能被触发。若两条路径都弹 Toast、都拉光标，用户会看到
 *    两个 Toast、光标被拉扯两次。
 *
 *    解决办法：拦截器成功接管后，把该 URI 记录到共享 Map；兜底路径检测到
 *    URI 已被拦截器处理过（3s 窗口内），就只做"静默切换"（关 tab + openWith
 *    default），不再弹 Toast、不再拉光标。
 * ============================================================================
 */
import type * as vscode from 'vscode';

const HANDLED_TTL_MS = 3000;
const yamlInterceptedAt = new Map<string, number>();

/**
 * 标记该 URI 已被拦截器完整处理（Toast + 光标定位都已完成）。
 */
export function markInterceptorHandled(uri: vscode.Uri): void {
    yamlInterceptedAt.set(uri.toString(), Date.now());
}

/**
 * 兜底路径调用：判断该 URI 是否在 3 秒内已被拦截器处理过。
 * 若返回 true，兜底应"静默切换"（不弹 Toast、不定位光标）。
 */
export function wasHandledByInterceptor(uri: vscode.Uri): boolean {
    const key = uri.toString();
    const at = yamlInterceptedAt.get(key);
    if (!at) return false;
    if (Date.now() - at < HANDLED_TTL_MS) return true;
    yamlInterceptedAt.delete(key);
    return false;
}
