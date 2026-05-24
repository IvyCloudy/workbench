// ============ 加载状态组件 ============

import { escapeHtml } from '../utils/helpers.js';

export class Loading {
    constructor(containerSelector, options = {}) {
        this.container = typeof containerSelector === 'string'
            ? document.querySelector(containerSelector)
            : containerSelector;
        this.options = {
            defaultMessage: '加载中...',
            ...options
        };
    }

    show(message) {
        if (!this.container) return;
        this.container.classList.remove('hidden');
        this.container.textContent = message || this.options.defaultMessage;
        // 还原为普通 loading 样式（清除 error 颜色）
        this.container.classList.remove('error');
        this.container.classList.add('loading');
    }

    hide() {
        if (!this.container) return;
        this.container.classList.add('hidden');
    }

    showError(message) {
        if (!this.container) return;
        this.container.classList.remove('hidden', 'loading');
        this.container.classList.add('error');
        this.container.innerHTML = escapeHtml(message || '加载失败');
    }

    destroy() {
        this.hide();
    }
}