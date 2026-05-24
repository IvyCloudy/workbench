// ============ 通用工具函数 ============

/**
 * HTML 转义（用于文本内容）
 */
export function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * HTML 属性转义
 */
export function escapeAttr(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/\n/g, '&#10;');
}

/**
 * 防抖
 */
export function debounce(func, wait) {
    let timer;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => func.apply(this, args), wait);
    };
}

/**
 * 节流
 */
export function throttle(func, limit) {
    let inThrottle = false;
    return function (...args) {
        if (inThrottle) return;
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => (inThrottle = false), limit);
    };
}