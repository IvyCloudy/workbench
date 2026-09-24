/**
 * ============================================================================
 *  preValidate/preValidateGate.ts
 *  推送前置校验门控 — 扩展端 ↔ webview 双向通信管理
 * ----------------------------------------------------------------------------
 *  从 utils/preValidateGate.ts 迁移过来（2026-09-19 解耦），
 *  语义与依赖完全不变。原路径保留为 re-export barrel（@deprecated）。
 *
 *  职责：
 *    1. openPreValidateGate(panel, fileName, failures) → Promise<'continue' | 'cancel'>
 *       发消息给 webview 展示前置校验窗口，等待用户点击「取消」/「忽略并继续」
 *       后 resolve；有 error 时窗口只允许「取消」（Q2=A）。
 *    2. resolvePreValidateGate(gateId, decision) 由消息 handler 在收到 webview
 *       回消息（type='preValidateGateResponse'）时调用，将对应 Promise 结算。
 *    3. panel 销毁或超时时自动 fallback 为 'cancel'，避免 runPush 悬挂。
 *
 *  语义（Q1/Q2/Q3 决策）：
 *    - Q1=A：只要有 warn/error 均触发窗口，一次入口覆盖所有前置问题；
 *    - Q2=A：「忽略并继续」按钮仅当 (allowContinue=true 且 仅有 warn) 时出现；
 *            allowContinue=false（打开文件 / 格式校验按钮，纯查看问题）或 有 error 时，
 *            窗口只显示「关闭」，用户只能取消；
 *    - Q3=B：cancel 后 runPush 短路走 onComplete（failures 完整回传），
 *            由完成态弹窗展示同一份清单，语义一致。
 * ============================================================================
 */
import * as vscode from 'vscode';
import type { PushFailureItem } from '../handlers/pushCore.types';

/** 单条 pending 门控 Promise 的登记条目。 */
interface PendingGate {
    resolve: (decision: 'continue' | 'cancel') => void;
    /** 面板 disposed 时自动结算的清理函数（避免 memory leak）。 */
    dispose: vscode.Disposable | null;
    /** 超时定时器（60s 兜底，防止 webview 侧脚本异常导致悬挂）。 */
    timer: NodeJS.Timeout | null;
}

/** gateId → PendingGate 全局注册表（同一时刻可能有多个 panel 各自 pending）。 */
const _pendingGates = new Map<string, PendingGate>();

/** 单调递增 id 生成器，用于给每次 gate 一个唯一标识。 */
let _gateSeq = 0;

/** 默认超时（毫秒）：60s 无响应视为 cancel，避免主流程挂死。 */
const GATE_TIMEOUT_MS = 60 * 1000;

/**
 * 打开前置校验窗口，返回用户决策。
 */
export function openPreValidateGate(
    panel: vscode.WebviewPanel | undefined,
    fileName: string,
    failures: PushFailureItem[],
    /**
     * 是否允许"忽略并继续"按钮：
     *   · 推送前置门控（pushStrategy 调用）→ true：warn 级问题时用户可"忽略并继续"推送；
     *   · 打开文件 / 格式校验按钮（postFileLevelPreValidateGate）→ false：
     *     纯查看问题、无"继续"动作可触发，"忽略并继续"语义不成立，始终只显示"关闭"。
     */
    allowContinue: boolean = true,
): Promise<'continue' | 'cancel'> {
    if (!panel) {
        return Promise.resolve('continue');
    }
    const gateId = `gate-${Date.now().toString(36)}-${(++_gateSeq).toString(36)}`;
    return new Promise<'continue' | 'cancel'>((resolve) => {
        const dispose = panel.onDidDispose(() => {
            const entry = _pendingGates.get(gateId);
            if (entry) {
                _pendingGates.delete(gateId);
                if (entry.timer) clearTimeout(entry.timer);
                entry.resolve('cancel');
            }
        });
        const timer = setTimeout(() => {
            const entry = _pendingGates.get(gateId);
            if (entry) {
                _pendingGates.delete(gateId);
                if (entry.dispose) entry.dispose.dispose();
                console.warn(`[preValidateGate] 超时未响应（${GATE_TIMEOUT_MS}ms），按 cancel 兜底 gateId=${gateId}`);
                entry.resolve('cancel');
            }
        }, GATE_TIMEOUT_MS);
        _pendingGates.set(gateId, { resolve, dispose, timer });

        try {
            panel.webview.postMessage({
                type: 'preValidateGate',
                gateId,
                fileName,
                allowContinue,
                failures: failures.map(f => ({
                    tsId: f.tsId,
                    reason: f.reason,
                    rowIndex: f.rowIndex,
                    severity: f.severity || 'error',
                    field: f.field,
                    // R2（2026-09-19）：同行多字段命中时，把每条 hit 的独立单字段话术透给 webview，
                    //   05g 弹窗按 hits[i].singleReason 逐条渲染 bullet（"每项各一条"），
                    //   顶层 reason 仍保留完整汇总句以兼容单 hit 回退渲染路径。
                    hits: Array.isArray(f.hits) ? f.hits.map(h => ({
                        field: h.field,
                        stepIdx: h.stepIdx,
                        subField: h.subField,
                        singleReason: h.singleReason,
                    })) : undefined,
                })),
            });
        } catch (err: any) {
            const entry = _pendingGates.get(gateId);
            if (entry) {
                _pendingGates.delete(gateId);
                if (entry.timer) clearTimeout(entry.timer);
                if (entry.dispose) entry.dispose.dispose();
                console.warn('[preValidateGate] postMessage 失败，按 cancel 兜底:', err?.message || err);
                entry.resolve('cancel');
            }
        }
    });
}

/**
 * 由 webview 回消息 handler 调用，结算指定 gateId 的 Promise。
 */
export function resolvePreValidateGate(gateId: string, decision: 'continue' | 'cancel'): void {
    const entry = _pendingGates.get(gateId);
    if (!entry) return;
    _pendingGates.delete(gateId);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.dispose) entry.dispose.dispose();
    const normalized = decision === 'continue' ? 'continue' : 'cancel';
    entry.resolve(normalized);
}
