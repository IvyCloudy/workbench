// ============ 文件树组件 ============

import { escapeHtml, escapeAttr } from '../utils/helpers.js';

export class FileTree {
    constructor(containerSelector, options = {}) {
        this.container = typeof containerSelector === 'string'
            ? document.querySelector(containerSelector)
            : containerSelector;
        this.options = {
            onFileClick: null,
            onFolderClick: null,
            ...options
        };
        this.currentPath = null;
    }

    render(files) {
        if (!this.container) return;
        if (!files || files.length === 0) {
            this.container.innerHTML = '<div class="file-tree-empty">未找到"测试任务"目录</div>';
            return;
        }
        this.container.innerHTML = this._buildHTML(files, 0);
        this._bindEvents();
    }

    selectFile(filePath) {
        this.container?.querySelectorAll('.file-tree-node').forEach(n => n.classList.remove('active'));
        const target = this.container?.querySelector(`[data-path="${CSS.escape(filePath)}"]`);
        if (target) {
            target.classList.add('active');
            this.currentPath = filePath;
        }
    }

    getCurrentPath() {
        return this.currentPath;
    }

    clear() {
        if (this.container) this.container.innerHTML = '';
        this.currentPath = null;
    }

    destroy() {
        this.clear();
    }

    // ==================== 内部方法 ====================

    _buildHTML(nodes, level) {
        let html = '';
        nodes.forEach(node => {
            const padding = 12 + level * 24;
            if (node.children && node.children.length > 0) {
                // 文件夹
                html += `<div class="file-tree-node folder" data-path="${escapeAttr(node.path || '')}" style="padding-left:${padding}px">`;
                html += `<span class="icon">${level === 0 ? '📁' : '📂'}</span>`;
                html += `<span class="name">${escapeHtml(node.name)}</span></div>`;
                html += this._buildHTML(node.children, level + 1);
            } else {
                // 文件
                html += `<div class="file-tree-node file" data-path="${escapeAttr(node.path || '')}" style="padding-left:${padding}px">`;
                html += `<span class="icon">📄</span>`;
                html += `<span class="name">${escapeHtml(node.name)}</span></div>`;
            }
        });
        return html;
    }

    _bindEvents() {
        this.container.querySelectorAll('.file-tree-node.file').forEach(node => {
            node.addEventListener('click', () => {
                this.container.querySelectorAll('.file-tree-node.file').forEach(n => n.classList.remove('active'));
                node.classList.add('active');
                const filePath = node.getAttribute('data-path');
                this.currentPath = filePath;
                this.options.onFileClick?.(filePath);
            });
        });

        this.container.querySelectorAll('.file-tree-node.folder').forEach(node => {
            node.addEventListener('click', () => {
                const folderPath = node.getAttribute('data-path');
                this.options.onFolderClick?.(folderPath);
            });
        });
    }
}