// ============ 通用表格组件 ============

import { escapeHtml, escapeAttr } from '../utils/helpers.js';

export class Table {
    constructor(containerSelector, options = {}) {
        this.container = typeof containerSelector === 'string'
            ? document.querySelector(containerSelector)
            : containerSelector;
        this.options = {
            selectable: true,
            resizable: true,
            ...options
        };
        this.selectedRows = new Set();
        this.data = null;
        this.onSelectionChange = null;
    }

    render(data) {
        this.data = data;
        this.selectedRows.clear();

        if (!this.container) return;
        if (!data || !data.rows || data.rows.length === 0) {
            this.container.innerHTML = this._renderEmpty();
            return;
        }

        this.container.classList.remove('hidden');
        this.container.innerHTML = this._buildTableHTML(data);
        this._bindSelectionEvents();

        if (this.options.resizable) {
            this._enableColumnResize();
        }
    }

    showEmpty(message = '暂无数据') {
        if (!this.container) return;
        this.container.classList.remove('hidden');
        this.container.innerHTML = `<div class="csv-empty"><div class="icon">📄</div><div>${escapeHtml(message)}</div></div>`;
    }

    showError(message) {
        if (!this.container) return;
        this.container.classList.remove('hidden');
        this.container.innerHTML = `<div class="csv-empty"><div class="icon">❌</div><div>${escapeHtml(message)}</div></div>`;
    }

    selectAll() {
        this.container?.querySelectorAll('.row-checkbox').forEach(cb => {
            cb.checked = true;
            const idx = parseInt(cb.getAttribute('data-index'), 10);
            this.selectedRows.add(idx);
        });
        this._updateRowStyles();
        this._updateSelectAllState();
        this.onSelectionChange?.();
    }

    unselectAll() {
        this.container?.querySelectorAll('.row-checkbox').forEach(cb => {
            cb.checked = false;
        });
        this.selectedRows.clear();
        this._updateRowStyles();
        this._updateSelectAllState();
        this.onSelectionChange?.();
    }

    getSelectedRows() {
        if (!this.data?.rows) return [];
        return Array.from(this.selectedRows).map(idx => this.data.rows[idx]);
    }

    getSelectedCount() {
        return this.selectedRows.size;
    }

    destroy() {
        this.selectedRows.clear();
        this.data = null;
    }

    // ==================== 内部方法 ====================

    _renderEmpty() {
        return '<div class="csv-empty"><div class="icon">📄</div><div>暂无数据</div></div>';
    }

    _buildTableHTML(data) {
        const headers = data.headers || [];
        const rows = data.rows || [];

        let html = '<table class="csv-table">';

        // 表头
        html += '<thead><tr>';
        if (this.options.selectable) {
            html += '<th class="checkbox"><input type="checkbox" id="selectAll"></th>';
        }
        headers.forEach(header => {
            html += `<th>${escapeHtml(header)}<span class="resize-handle"></span></th>`;
        });
        html += '</tr></thead>';

        // 表体
        html += '<tbody>';
        rows.forEach((row, idx) => {
            html += `<tr data-index="${idx}">`;
            if (this.options.selectable) {
                html += `<td class="checkbox"><input type="checkbox" class="row-checkbox" data-index="${idx}"></td>`;
            }
            row.forEach(cell => {
                const text = cell == null ? '' : String(cell);
                html += `<td title="${escapeAttr(text)}"><div class="cell-trunc">${escapeHtml(text)}</div></td>`;
            });
            html += '</tr>';
        });
        html += '</tbody></table>';

        return html;
    }

    _bindSelectionEvents() {
        if (!this.options.selectable) return;

        const selectAll = this.container.querySelector('#selectAll');
        if (selectAll) {
            selectAll.addEventListener('change', (e) => {
                if (e.target.checked) this.selectAll();
                else this.unselectAll();
            });
        }

        this.container.querySelectorAll('.row-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const idx = parseInt(e.target.getAttribute('data-index'), 10);
                if (e.target.checked) this.selectedRows.add(idx);
                else this.selectedRows.delete(idx);
                this._updateRowStyles();
                this._updateSelectAllState();
                this.onSelectionChange?.();
            });
        });
    }

    _updateSelectAllState() {
        const selectAll = this.container?.querySelector('#selectAll');
        if (!selectAll) return;
        const all = this.container.querySelectorAll('.row-checkbox');
        const checked = this.container.querySelectorAll('.row-checkbox:checked').length;
        selectAll.checked = all.length > 0 && checked === all.length;
        selectAll.indeterminate = checked > 0 && checked < all.length;
    }

    _updateRowStyles() {
        this.container?.querySelectorAll('tbody tr').forEach(tr => {
            const idx = parseInt(tr.getAttribute('data-index'), 10);
            tr.classList.toggle('selected', this.selectedRows.has(idx));
        });
    }

    _enableColumnResize() {
        const ths = this.container.querySelectorAll('th');
        ths.forEach((th, idx) => {
            const handle = th.querySelector('.resize-handle');
            if (!handle) return;
            handle.addEventListener('mousedown', (e) => this._onResizeStart(e, th, idx));
        });
    }

    _onResizeStart(e, th, idx) {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = th.offsetWidth;

        const onMove = (ev) => {
            const newWidth = Math.max(30, startWidth + (ev.clientX - startX));
            const cells = this.container.querySelectorAll(`tr > *:nth-child(${idx + 1})`);
            cells.forEach(cell => {
                cell.style.width = newWidth + 'px';
                cell.style.minWidth = newWidth + 'px';
                cell.style.maxWidth = newWidth + 'px';
            });
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }
}