/**
 * ============================================================================
 *  services/utils.ts
 *  扩展端通用工具集
 * ----------------------------------------------------------------------------
 *  内容分组：
 *    1. FILE_PATTERNS：CSV/YAML/JSON 后缀正则
 *    2. CSP nonce / HTML escape / 错误页 HTML 模板（buildErrorHtml）
 *    3. 路径合规校验（isInQualifiedDir）
 *    4. 推送追踪相关常量与 UUID 生成
 *  设计要点：
 *    - 本文件不依赖 vscode.workspace 等运行时上下文，纯工具函数，便于单测。
 *    - 任务信息（testTaskNo / subTestTaskName）统一由 getCurrentTaskInfo /
 *      getTaskInfoByFilePath 基于 task-bindings.json 提供。
 * ============================================================================
 */
import * as crypto from 'crypto';
import * as path from 'path';

// ============================================
// 文件类型匹配模式
// ============================================

export const FILE_PATTERNS = {
    CSV: /\.csv$/i,
    YAML: /\.ya?ml$/i,
    JSON: /\.json$/i,
} as const;

// ============================================
// CSP nonce
// ============================================

const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * 生成 CSP nonce
 */
export function getNonce(length: number = 64): string {
    let result = '';
    for (let i = 0; i < length; i++) {
        result += NONCE_CHARS.charAt(Math.floor(Math.random() * NONCE_CHARS.length));
    }
    return result;
}

// ============================================
// HTML
// ============================================

/**
 * HTML 字符转义
 */
export function escapeHtml(str: string): string {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 构建错误页 HTML（统一样式）。
 * @param message 错误描述
 * @param title   标题
 * @param actions 可选操作按钮：点击后会通过 postMessage 向扩展端发送 { type: action }
 */
export function buildErrorHtml(
    message: string,
    title: string = '错误',
    actions: Array<{ label: string; action: string; primary?: boolean }> = []
): string {
    const safeTitle = escapeHtml(title);
    const safeMessage = escapeHtml(message);
    const buttonsHtml = actions
        .map(a => `<button class="btn${a.primary ? ' btn-p' : ''}" data-act="${escapeHtml(a.action)}">${escapeHtml(a.label)}</button>`)
        .join('');
    const scriptHtml = actions.length
        ? `<script>
const vscode = acquireVsCodeApi();
document.querySelectorAll('button[data-act]').forEach(b => {
    b.addEventListener('click', () => vscode.postMessage({ type: b.getAttribute('data-act') }));
});
</script>`
        : '';
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            background: #f5f6f8;
        }
        .msg {
            text-align: center;
            padding: 40px;
            background: #fff;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,.1);
            max-width: 520px;
        }
        .msg h3 { color: #e34d59; margin: 0 0 12px; }
        .msg p { color: #666; font-size: 14px; margin: 0 0 20px; line-height: 1.6; white-space: pre-line; text-align: left; }
        .actions { display: flex; gap: 8px; justify-content: center; }
        .btn {
            padding: 6px 16px; font-size: 13px; cursor: pointer;
            border: 1px solid #d9d9d9; background: #fff; color: #333; border-radius: 3px;
        }
        .btn:hover { border-color: #1677ff; color: #1677ff; }
        .btn-p { background: #1677ff; color: #fff; border-color: #1677ff; }
        .btn-p:hover { background: #4096ff; color: #fff; }
    </style>
</head>
<body>
    <div class="msg">
        <h3>${safeTitle}</h3>
        <p>${safeMessage}</p>
        ${buttonsHtml ? `<div class="actions">${buttonsHtml}</div>` : ''}
    </div>
    ${scriptHtml}
</body>
</html>`;
}

// ============================================
// 文件路径校验
// ============================================

/**
 * 判断文件是否位于「临时文件」文件夹内，从而不应被识别为测试案例。
 *
 * 规则（强制）：路径中任一【目录段】（不含文件名本身）精确等于「临时文件」才判定命中。
 * 典型场景：测试任务/<任务>/测试案例/临时文件/xxx.json
 *
 * 这些目录下的 .csv / .yaml / .yml / .json 一律不识别为案例，
 * 因此不支持案例编辑器展示、单文件推送、批量推送文件夹，且右键菜单（推送案例 / 绑定测试要点等）隐藏。
 */
export function isInTempFolder(filePath: string): boolean {
    if (!filePath) return false;
    // 同时兼容正斜杠（工作区相对路径）与平台分隔符（绝对路径），避免 Windows 下漏判。
    const parts = filePath.split(/[\\/]/);
    // 末位是文件名，目录段为 parts[0..len-2]
    for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i] === '临时文件') return true;
    }
    return false;
}

/**
 * 检查文件是否在合格目录下：
 *   测试任务/<任务目录>/测试案例/[...]/<file>
 * 层级严格从【打开的工作区文件夹】起算：
 *   - 第 1 层必须是「测试任务」；
 *   - 第 2 层是测试任务名称（任意文件夹名，不强制 <编号>_<名称> 格式）；
 *   - 第 3 层必须是「测试案例」；
 *   - 案例文件可直接放在「测试案例」目录下，也可放在其子目录中。
 * 即入参 filePath 应为「相对工作区文件夹」的路径，且 parts[0]==='测试任务'、parts[2]==='测试案例'。
 *
 * 注意：位于「临时文件」文件夹（目录段精确等于「临时文件」）内的文件一律返回 false，
 *       不识别为测试案例（见 isInTempFolder 注释）。
 */
export function isInQualifiedDir(filePath: string, filePattern: RegExp): boolean {
    if (!filePath || !filePattern.test(filePath)) {
        return false;
    }

    // 临时文件夹内的文件不识别为测试案例（编辑器 / 推送 / 批量推送均据此排除）。
    if (isInTempFolder(filePath)) return false;

    // 兼容 mac/Windows 分隔符（与右键菜单 when 正则使用的 [\\/] 一致），并去掉可能的首部空段
    // （绝对路径以分隔符开头会产生空段，但本函数期望接收「相对工作区文件夹」的路径）。
    const parts = filePath.split(/[\\/]/).filter(Boolean);
    const len = parts.length;
    if (len < 4) return false;

    // 第 1 层必须是「测试任务」
    if (parts[0] !== '测试任务') return false;
    // 第 2 层是任务目录（任意名称）
    if (!parts[1]) return false;
    // 第 3 层必须是「测试案例」（不是则即使更深层存在合格三元组也不算，避免误判）
    if (parts[2] !== '测试案例') return false;

    // 文件名匹配（文件可在 测试案例/ 目录或其子目录下）
    const lastPart = parts[len - 1];
    return filePattern.test(lastPart);
}

/**
 * 为「不在合格目录下」的文件生成清晰的中文排查说明。
 * @param relPath  相对打开的工作区根目录的路径（parts[0] 即第 1 层）。
 * @param typeName 文件类型友好名（如 JSON / YAML / CSV），用于措辞。
 *
 * 说明会指出：要求的目录结构、当前文件相对工作区的完整路径、具体哪一层不合规，
 * 以及常见误嵌套（路径中存在多个「测试任务」）提示，帮助用户自行定位问题。
 */
export function explainUnqualified(relPath: string, typeName: string): string {
    const parts = relPath.split(/[\\/]/).filter(Boolean);
    const currentPath = parts.length ? parts.join(' / ') : '(无法解析相对路径)';
    const expected = '测试任务 / <任务文件夹> / 测试案例 / … / <文件>';

    const issues: string[] = [];
    if (parts.length < 4) {
        issues.push(
            `· 路径层级不足：至少需要「测试任务 / 任务文件夹 / 测试案例 / 文件」四层，当前只有 ${parts.length} 层。`
        );
    } else {
        if (parts[0] !== '测试任务') {
            issues.push(`· 第 1 层应为「测试任务」，当前为「${parts[0]}」。`);
        }
        if (parts[2] !== '测试案例') {
            issues.push(`· 第 3 层应为「测试案例」，当前为「${parts[2]}」。`);
        }
    }
    // 多个「测试任务」目录通常是文件夹被重复嵌套了一层，最容易被忽略
    const dupTask = parts.filter(p => p === '测试任务').length > 1;
    if (dupTask) {
        issues.push('· 路径中存在多个「测试任务」目录，可能是文件夹被重复嵌套了一层。');
    }

    const header = `该 ${typeName} 文件不在案例目录规则内，无法用「测试案例编辑器」打开。`;
    const structure = `要求的路径结构（相对打开的工作区根目录）：\n  ${expected}`;
    const current = `当前文件相对工作区的路径：\n  ${currentPath}`;
    const why = issues.length
        ? '问题定位：\n' + issues.join('\n')
        : '问题定位：\n  · 不符合「测试任务 / <任务文件夹> / 测试案例」层级。';
    const hint = '排查建议：\n'
        + '  · 将该文件移动到「测试任务 / 某任务 / 测试案例」目录下；\n'
        + '  · 或在资源浏览器中右键文件，确认其处于正确目录后再「用测试案例编辑器打开」。';

    return [header, '', structure, '', current, '', why, '', hint].join('\n');
}

// ============================================
// 推送相关：固定列名 & UUID
// ============================================

/** 推送追踪列：行的唯一 id，请求时回传给后端，用于响应回写匹配 */
export const TS_ID_COLUMN = 'testcase_id';
/** 推送成功回写列：成功时存放后端返回的 testCaseNo */
export const TEST_CASE_NO_COLUMN = 'testCaseNo';

/**
 * 生成 MA + hex 格式 UUID（Node 端用 crypto.randomBytes）
 */
export function genUuid(): string {
    return 'MA' + crypto.randomBytes(16).toString('hex');
}

// ============================================
// 错误工具
// ============================================

/**
 * 提取错误堆栈头几行用于上报，避免信息泄漏
 */
export function stackHead(err: any, lines = 5): string {
    const stack = err && err.stack ? String(err.stack) : '';
    return stack.split('\n').slice(0, lines).join(' | ').slice(0, 1000);
}

/**
 * 从任意 error / thrown value 构造标准埋点错误属性：
 *   - errorMessage：截断到 500 字符（避免超 payload 上限）
 *   - stackHead   ：栈头一行（不包含具体路径，便于聚合）
 * 可通过 extra 附加业务维度（如 fileFormat / apiName / rowIdx 等）；
 * extra 中同名字段可覆盖默认 errorMessage / stackHead（如已预处理过的错误消息）。
 * 用法：
 *   TelemetryService.sendTelemetryErrorEvent('editor.save.error', buildErrorProps(err, { fileFormat }))
 */
export function buildErrorProps(err: any, extra?: Record<string, string>): Record<string, string> {
    const errorMessage = String(err?.message || String(err)).slice(0, 500);
    return { errorMessage, stackHead: stackHead(err), ...(extra || {}) };
}

// ============================================
// 日志时间戳
// ============================================

/**
 * 生成 hh:mm:ss.ms 格式的时间戳字符串，用于扩展端日志前缀，方便前后端事件比对时序。
 * 不含日期部分（VS Code 输出面板日志同一天不会跨天，重启即清空）。
 * @param d 可选，默认 new Date()
 */
export function formatLogTime(d: Date = new Date()): string {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
}