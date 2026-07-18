/**
 * ============================================================================
 *  media/pages/bind-dialog/main.js
 *  绑定弹窗前端逻辑
 * ----------------------------------------------------------------------------
 *  与扩展端通信协议：
 *    - 扩展 → webview:
 *        { command: 'init', payload }
 *        { command: 'saved' }
 *        { command: 'saveError', message }
 *    - webview → 扩展:
 *        { command: 'ready' }
 *        { command: 'save', selected: [absPath...] }
 *        { command: 'cancel' }
 *        { command: 'reveal', absPath }
 * ============================================================================
 */

(function () {
    // eslint-disable-next-line no-undef
    const vscode = acquireVsCodeApi();

    /** @type {any} */
    let state = {
        direction: 'point-to-cases',
        sourceAbsPath: '',
        sourceRelPath: '',
        sourceName: '',
        scopeTaskName: '',
        targetLabel: '目标文件',
        candidates: /** @type {any[]} */ ([]),
        /** 当前选中的候选项 absPath；null 表示未选（保存等价于解绑） */
        selectedAbs: /** @type {string|null} */ (null),
        /** store 中源文件当前已绑定的对端相对路径（1:1，最多 1 个），仅展示用 */
        currentBoundRel: /** @type {string|null} */ (null),
        currentBoundAbs: /** @type {string|null} */ (null),
        /** 过滤：仅显示未绑定 */
        onlyUnbound: true,
        /** 搜索关键字 */
        keyword: '',
        saving: false,
    };

    // ---------- DOM ----------
    const $ = (id) => document.getElementById(id);
    const el = {
        dialogTitle: $('dialogTitle'),
        srcName: $('srcName'),
        scopeName: $('scopeName'),
        currentBoundBar: $('currentBoundBar'),
        currentBoundVal: $('currentBoundVal'),
        currentBoundLocate: $('currentBoundLocate'),
        searchInput: $('searchInput'),
        onlyUnbound: $('onlyUnbound'),
        onlyUnboundChip: $('onlyUnboundChip'),
        clearAllBtn: $('clearAllBtn'),
        countInfo: $('countInfo'),
        candList: $('candList'),
        emptyState: $('emptyState'),
        targetLabel: $('targetLabel'),
        selHint: $('selHint'),
        cancelBtn: $('cancelBtn'),
        saveBtn: $('saveBtn'),
    };

    // ---------- 工具 ----------
    function escapeHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function extBadgeClass(ext) {
        return 'ext-badge badge-' + (ext || 'unknown');
    }

    // ---------- 渲染 ----------
    function renderHeader() {
        el.dialogTitle.textContent = state.direction === 'point-to-cases'
            ? '绑定测试案例'
            : '绑定测试要点';
        el.srcName.textContent = state.sourceRelPath || state.sourceName;
        el.srcName.title = state.sourceAbsPath;
        el.scopeName.textContent = state.scopeTaskName;
        el.targetLabel.textContent = state.targetLabel;
        if (state.currentBoundRel) {
            el.currentBoundBar.classList.remove('hidden');
            el.currentBoundVal.textContent = state.currentBoundRel;
            el.currentBoundVal.title = state.currentBoundAbs || state.currentBoundRel;
        } else {
            el.currentBoundBar.classList.add('hidden');
        }
    }

    function getFilteredList() {
        const kw = state.keyword.trim().toLowerCase();
        const list = state.candidates.filter(c => {
            // "仅显示未绑定" = 隐藏被别人占用的项；当前源文件已绑定的项始终保留（用户需要能看到并操作解绑）
            if (state.onlyUnbound && c.boundToOthers && !c.boundToSource) return false;
            if (kw) {
                const hay = (c.name + ' ' + c.relPath).toLowerCase();
                if (!hay.includes(kw)) return false;
            }
            return true;
        });
        // 排序：当前已绑定 > 未绑定 > 被别人占用；同组内按相对路径排
        return list.sort((a, b) => {
            const rank = (x) => x.boundToSource ? 0 : (x.boundToOthers ? 2 : 1);
            const ra = rank(a), rb = rank(b);
            if (ra !== rb) return ra - rb;
            return a.relPath.localeCompare(b.relPath, 'zh-CN');
        });
    }

    function renderList() {
        const list = getFilteredList();
        el.countInfo.innerHTML = `共 <span class="num">${list.length}</span> 项`;

        if (list.length === 0) {
            el.candList.innerHTML = '';
            el.emptyState.classList.remove('hidden');
            renderFooter();
            return;
        }
        el.emptyState.classList.add('hidden');

        const html = list.map(item => {
            const checked = state.selectedAbs === item.absPath;
            const wasBound = item.boundToSource;
            const disabled = !!item.boundToOthers;
            const classes = ['cand-item'];
            if (checked) classes.push('checked');
            if (wasBound) classes.push('was-bound');
            if (disabled) classes.push('disabled');

            let statusTag = '';
            if (wasBound) {
                statusTag = '<span class="status-tag bound">当前已绑定</span>';
            } else if (disabled) {
                const owner = item.boundToOwnerRel ? escapeHtml(item.boundToOwnerRel) : '其他项';
                statusTag = `<span class="status-tag occupied" title="已被绑定：${owner}">已被绑定</span>`;
            }

            return `
                <li class="${classes.join(' ')}" data-abs="${escapeHtml(item.absPath)}" ${disabled ? 'data-disabled="1"' : ''}>
                    <input type="radio" name="bind-target" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} data-abs="${escapeHtml(item.absPath)}" />
                    <div class="info">
                        <div class="name">
                            <span>${escapeHtml(item.name)}</span>
                            <span class="${extBadgeClass(item.ext)}">${escapeHtml(item.ext)}</span>
                            ${statusTag}
                        </div>
                        <div class="path" title="${escapeHtml(item.relPath)}">${escapeHtml(item.relPath)}</div>
                    </div>
                    <button class="reveal-btn" data-reveal="${escapeHtml(item.absPath)}" title="在资源管理器中定位">↗</button>
                </li>
            `;
        }).join('');
        el.candList.innerHTML = html;
        renderFooter();
    }

    function renderFooter() {
        if (state.selectedAbs) {
            const item = state.candidates.find(c => c.absPath === state.selectedAbs);
            const rel = item ? item.relPath : state.selectedAbs;
            el.selHint.innerHTML = `已选择：<span class="num">${escapeHtml(rel)}</span>`;
        } else {
            // 若源文件原本就有绑定，且此时选择被清空，表示"保存后解绑"
            const originallyBound = state.candidates.some(c => c.boundToSource);
            el.selHint.textContent = originallyBound ? '未选择（保存后将解除当前绑定）' : '未选择';
        }
        el.saveBtn.disabled = state.saving;
        el.saveBtn.textContent = state.saving ? '保存中...' : '保存绑定';
    }

    // ---------- 事件 ----------
    function bindEvents() {
        el.searchInput.addEventListener('input', (e) => {
            state.keyword = e.target.value || '';
            renderList();
        });

        el.onlyUnbound.addEventListener('change', (e) => {
            state.onlyUnbound = !!e.target.checked;
            el.onlyUnboundChip.classList.toggle('active', state.onlyUnbound);
            renderList();
        });

        // 取消绑定：清空选择
        el.clearAllBtn.addEventListener('click', () => {
            state.selectedAbs = null;
            renderList();
        });

        el.candList.addEventListener('click', (e) => {
            const target = e.target;
            if (!(target instanceof HTMLElement)) return;

            // 定位按钮
            const revealBtn = target.closest('[data-reveal]');
            if (revealBtn instanceof HTMLElement) {
                e.stopPropagation();
                const absPath = revealBtn.getAttribute('data-reveal');
                if (absPath) vscode.postMessage({ command: 'reveal', absPath });
                return;
            }

            // 找到 li 行
            const li = target.closest('.cand-item');
            if (!(li instanceof HTMLElement)) return;

            // 禁用行：忽略点击并给出轻提示
            if (li.getAttribute('data-disabled') === '1') {
                const owner = li.querySelector('.status-tag.occupied');
                if (owner instanceof HTMLElement && owner.title) {
                    // 使用行边框短暂闪烁提示
                    li.style.transition = 'box-shadow .3s';
                    li.style.boxShadow = '0 0 0 2px rgba(227,77,89,.35)';
                    setTimeout(() => { li.style.boxShadow = ''; }, 400);
                }
                return;
            }

            const absPath = li.getAttribute('data-abs');
            if (!absPath) return;

            // 单选：若点击已选行 → 取消；否则切为选中
            if (state.selectedAbs === absPath) {
                state.selectedAbs = null;
            } else {
                state.selectedAbs = absPath;
            }
            renderList();
        });

        el.cancelBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'cancel' });
        });

        // 头部"当前已绑定"的定位按钮
        if (el.currentBoundLocate) {
            el.currentBoundLocate.addEventListener('click', () => {
                if (state.currentBoundAbs) {
                    vscode.postMessage({ command: 'reveal', absPath: state.currentBoundAbs });
                }
            });
        }

        el.saveBtn.addEventListener('click', () => {
            if (state.saving) return;
            state.saving = true;
            renderFooter();
            vscode.postMessage({
                command: 'save',
                selected: state.selectedAbs ? [state.selectedAbs] : [],
            });
        });

        // Esc 关闭 / Cmd|Ctrl+Enter 保存
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                vscode.postMessage({ command: 'cancel' });
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                el.saveBtn.click();
            }
        });
    }

    // ---------- 消息接收 ----------
    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || !msg.command) return;
        if (msg.command === 'init') {
            const p = msg.payload || {};
            state.direction = p.direction || 'point-to-cases';
            state.sourceAbsPath = p.sourceAbsPath || '';
            state.sourceRelPath = p.sourceRelPath || '';
            state.sourceName = p.sourceName || '';
            state.scopeTaskName = p.scopeTaskName || '';
            state.targetLabel = p.targetLabel || '目标文件';
            state.candidates = Array.isArray(p.candidates) ? p.candidates : [];
            state.currentBoundRel = p.currentBoundRel || null;
            state.currentBoundAbs = p.currentBoundAbs || null;
            // 默认预选：已绑定的项（1:1 场景下至多 1 个）
            const bound = state.candidates.find(c => c.boundToSource);
            state.selectedAbs = bound ? bound.absPath : null;
            renderHeader();
            renderList();
        } else if (msg.command === 'saved') {
            state.saving = false;
            renderFooter();
        } else if (msg.command === 'saveError') {
            state.saving = false;
            renderFooter();
            alert('保存失败：' + (msg.message || '未知错误'));
        }
    });

    // ---------- 启动 ----------
    bindEvents();
    vscode.postMessage({ command: 'ready' });
})();
