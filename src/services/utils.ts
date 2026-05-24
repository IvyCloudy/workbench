/**
 * ============================================================================
 *  services/utils.ts
 *  扩展端通用工具集
 * ----------------------------------------------------------------------------
 *  内容分组：
 *    1. FILE_PATTERNS：CSV/YAML/JSON 后缀正则
 *    2. CSP nonce / HTML escape / 错误页 HTML 模板（buildErrorHtml）
 *    3. 路径合规校验（isInQualifiedDir）
 *    4. ⭐ 任务信息解析（parseTaskInfoFromPath / resolveTaskInfo）
 *       - testTaskNo / subTestTaskName 的唯一来源；后续若调整规则只改这里
 *    5. 推送追踪相关常量与 UUID 生成
 *  设计要点：
 *    - 本文件不依赖 vscode.workspace 等运行时上下文，纯工具函数，便于单测。
 *    - resolveTaskInfo 始终返回 info（失败时为兜底空值），调用方可安全访问字段。
 * ============================================================================
 */
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
        .msg p { color: #666; font-size: 14px; margin: 0 0 20px; line-height: 1.6; }
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
 * 检查文件是否在合格目录下：
 *   .../{测试任务|testtask}/<task>/{测试案例|testcase}/<file>
 */
export function isInQualifiedDir(filePath: string, filePattern: RegExp): boolean {
    if (!filePath || !filePattern.test(filePath)) {
        return false;
    }

    const parts = filePath.split(path.sep);
    const len = parts.length;
    if (len < 4) return false;

    const dirNames = parts.map(p => path.basename(p));
    const caseDir = dirNames[len - 2];
    const rootDir = dirNames[len - 4];

    return (rootDir === '测试任务' || rootDir === 'testtask') &&
           (caseDir === '测试案例' || caseDir === 'testcase') &&
           filePattern.test(dirNames[len - 1]);
}

// ============================================
// 任务信息解析
// ============================================

export interface TaskInfo {
    /** 测试任务编号，例如 TT001 */
    testTaskNo: string;
    /** 测试子任务名称，例如 登录模块 */
    subTestTaskName: string;
}

/**
 * ⭐ testTaskNo / subTestTaskName 的唯一来源（内部实现）
 * ----------------------------------------------------------------
 * 后续如需调整两字段的取值方式（例如改为读 .meta 文件、改分隔符、
 * 从配置注入等），仅需修改本函数；所有调用方均经由 resolveTaskInfo
 * 间接使用，不应再单独解析路径。
 *
 * 目录约定：
 *   .../{测试任务|testtask}/<testTaskNo>_<subTestTaskName>/{测试案例|testcase}/<file>
 */
function parseTaskInfoFromPath(filePath: string): TaskInfo | null {
    if (!filePath) return null;
    const parts = filePath.split(path.sep);
    const len = parts.length;
    if (len < 4) return null;

    const rootDir = parts[len - 4];
    const taskDir = parts[len - 3];
    const caseDir = parts[len - 2];

    const rootOk = rootDir === '测试任务' || rootDir === 'testtask';
    const caseOk = caseDir === '测试案例' || caseDir === 'testcase';
    if (!rootOk || !caseOk || !taskDir) return null;

    const idx = taskDir.indexOf('_');
    if (idx <= 0 || idx === taskDir.length - 1) return null;

    return {
        testTaskNo: taskDir.slice(0, idx),
        subTestTaskName: taskDir.slice(idx + 1),
    };
}

/** 路径不合规时使用的统一提示语（仅本文件内部使用） */
const TASK_INFO_PARSE_ERROR =
    '无法解析测试任务信息，目录需形如：测试任务/<编号>_<子任务名>/测试案例/<文件>';

interface ResolveTaskInfoOk {
    ok: true;
    info: TaskInfo;
}
interface ResolveTaskInfoFail {
    ok: false;
    info: TaskInfo;   // 兜底空值，便于调用方安全访问字段
    error: string;    // 统一的错误描述
}
export type ResolveTaskInfoResult = ResolveTaskInfoOk | ResolveTaskInfoFail;

/**
 * ⭐ testTaskNo / subTestTaskName 的统一业务入口（推荐所有调用方使用）
 *
 * 与 parseTaskInfoFromPath 的区别：
 *   - parseTaskInfoFromPath：纯解析，失败返回 null，仅给底层 utils 用
 *   - resolveTaskInfo：业务入口，附带统一错误文案与兜底空值，所有调用方都应走这里
 *
 * 用法示例：
 *   const r = resolveTaskInfo(filePath);
 *   if (!r.ok) { showWarning(r.error); return; }
 *   const { testTaskNo, subTestTaskName } = r.info;
 */
export function resolveTaskInfo(filePath: string): ResolveTaskInfoResult {
    const info = parseTaskInfoFromPath(filePath);
    if (info) {
        return { ok: true, info };
    }
    return {
        ok: false,
        info: { testTaskNo: '', subTestTaskName: '' },
        error: TASK_INFO_PARSE_ERROR,
    };
}

// ============================================
// 推送相关：固定列名 & UUID
// ============================================

/** 推送追踪列：行的唯一 id，请求时回传给后端，用于响应回写匹配 */
export const TS_ID_COLUMN = 'tsId';
/** 推送成功回写列：成功时存放后端返回的 testCaseNo */
export const TEST_CASE_NO_COLUMN = 'testCaseNo';

/**
 * 生成 RFC4122 v4 UUID（无外部依赖，浏览器/Node 通用）
 */
export function genUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}