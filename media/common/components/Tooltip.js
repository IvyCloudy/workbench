// ============ 工具提示组件 ============

export class Tooltip {
    constructor(containerId = 'tooltip') {
        this.container = document.getElementById(containerId);
        if (!this.container) {
            this.container = document.createElement('div');
            this.container.id = containerId;
            document.body.appendChild(this.container);
        }
        this.timer = null;
    }

    show(htmlContent, x, y) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.container.innerHTML = htmlContent;
            this.container.style.display = 'block';
            this._updatePosition(x, y);
        }, 200);
    }

    hide() {
        clearTimeout(this.timer);
        this.container.style.display = 'none';
    }

    /**
     * 为表格容器启用单元格 tooltip：单元格 .cell-trunc 使用 data-tooltip 提供完整内容
     */
    enableForTable(tableContainer, cellSelector = '.cell-trunc') {
        if (!tableContainer) return;

        tableContainer.addEventListener('mouseover', (e) => {
            const cell = e.target.closest(cellSelector);
            if (!cell) return;
            const content = cell.getAttribute('data-tooltip') || cell.getAttribute('title') || cell.textContent;
            if (!content) return;
            this.show(content, e.clientX, e.clientY);
        });

        tableContainer.addEventListener('mousemove', (e) => {
            if (this.container.style.display === 'block') {
                this._updatePosition(e.clientX, e.clientY);
            }
        });

        tableContainer.addEventListener('mouseleave', () => {
            this.hide();
        });
    }

    destroy() {
        clearTimeout(this.timer);
        this.hide();
    }

    // ==================== 内部方法 ====================

    _updatePosition(x, y) {
        const gap = 16;
        const w = this.container.offsetWidth;
        const h = this.container.offsetHeight;
        let posX = x + gap;
        let posY = y + gap;
        if (posX + w > window.innerWidth - 8) posX = x - w - gap;
        if (posY + h > window.innerHeight - 8) posY = y - h - gap;
        this.container.style.left = Math.max(4, posX) + 'px';
        this.container.style.top = Math.max(4, posY) + 'px';
    }
}