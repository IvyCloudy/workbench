/**
 * ============================================================================
 *  media/pages/bind-dialog/main.js
 *  绑定弹窗前端逻辑
 * ----------------------------------------------------------------------------
 *  与扩展端通信协议：
 *    - 扩展 → webview:
 *        { command: 'init', payload }
 *        { command: 'loading', message }
 *        { command: 'saved' }
 *        { command: 'saveError', message }
 *    - webview → 扩展:
 *        { command: 'ready' }
 *        { command: 'save', selected: [absPath...] }
 *        { command: 'cancel' }
 *        { command: 'reveal', absPath }
 *        { command: 'openTargetDir', absPath }
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
        /** store 中源文件当前已绑定的对端相对/绝对路径（1:1，最多 1 个），仅展示用 */
        currentBoundRel: /** @type {string|null} */ (null),
        currentBoundAbs: /** @type {string|null} */ (null),
        /** 候选目录绝对路径（空态时展示） */
        targetDirAbs: /** @type {string|null} */ (null),
        /** 过滤：仅显示未绑定 */
        onlyUnbound: true,
        /** 搜索关键字 */
        keyword: '',
        saving: false,
        /** 是否处于加载态 */
        loading: true,
        /** 用于统计埋点：初始已绑定值（用于对比检测用户是否修改） */
        initialBoundAbs: /** @type {string|null} */ (null),
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
        currentBoundUnbind: $('currentBoundUnbind'),
        headerClose: $('headerClose'),
        errorBanner: $('errorBanner'),
        errorBannerMsg: $('errorBannerMsg'),
        errorBannerClose: $('errorBannerClose'),
        searchInput: $('searchInput'),
        onlyUnbound: $('onlyUnbound'),
        onlyUnboundChip: $('onlyUnboundChip'),
        clearAllBtn: $('clearAllBtn'),
        countInfo: $('countInfo'),
        candList: $('candList'),
        emptyState: $('emptyState'),
        emptyTargetDir: $('emptyTargetDir'),
        emptyOpenDirBtn: $('emptyOpenDirBtn'),
        skeletonWrap: $('skeletonWrap'),
        loadingText: $('loadingText'),
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

    function showErrorBanner(msg) {
        el.errorBannerMsg.textContent = msg || '未知错误';
        el.errorBanner.classList.remove('hidden');
    }
    function hideErrorBanner() {
        el.errorBanner.classList.add('hidden');
    }

    function setLoading(loading, text) {
        state.loading = loading;
        if (loading) {
            el.skeletonWrap.classList.remove('hidden');
            if (text) el.loadingText.textContent = text;
            el.candList.classList.add('hidden');
            el.emptyState.classList.add('hidden');
        } else {
            el.skeletonWrap.classList.add('hidden');
            el.candList.classList.remove('hidden');
        }
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
            // "隐藏已被占用" = 隐藏被别人占用的项；当前源文件已绑定的项始终保留
            if (state.onlyUnbound && c.boundToOthers && !c.boundToSource) return false;
            if (kw) {
                const hay = (c.name + ' ' + c.relPath).toLowerCase();
                if (!hay.includes(kw)) return false;
            }
            return true;
        });
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
            // 空态额外提示目标目录
            if (state.targetDirAbs) {
                el.emptyTargetDir.classList.remove('hidden');
                el.emptyTargetDir.textContent = state.targetDirAbs;
                el.emptyOpenDirBtn.classList.remove('hidden');
            } else {
                el.emptyTargetDir.classList.add('hidden');
                el.emptyOpenDirBtn.classList.add('hidden');
            }
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
                <li class="${classes.join(' ')}" data-abs="${escapeHtml(item.absPath)}" data-rel="${escapeHtml(item.relPath)}" ${disabled ? 'data-disabled="1"' : ''}>
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
        // 保存按钮文案随选中状态动态变化
        const originallyBound = !!state.initialBoundAbs;
        const nothingSelected = !state.selectedAbs;
        const sameAsBefore = state.selectedAbs === state.initialBoundAbs;

        if (state.selectedAbs) {
            const item = state.candidates.find(c => c.absPath === state.selectedAbs);
            const rel = item ? item.relPath : state.selectedAbs;
            el.selHint.innerHTML = `已选择：<span class="num">${escapeHtml(rel)}</span>`;
        } else {
            el.selHint.textContent = originallyBound ? '未选择（保存后将解除当前绑定）' : '未选择';
        }

        // 按钮标签
        if (state.saving) {
            el.saveBtn.textContent = '保存中...';
            el.saveBtn.classList.remove('btn-danger');
            el.saveBtn.classList.add('btn-primary');
        } else if (nothingSelected && originallyBound) {
            el.saveBtn.textContent = '解除绑定';
            el.saveBtn.classList.remove('btn-primary');
            el.saveBtn.classList.add('btn-danger');
        } else if (originallyBound && !sameAsBefore) {
            el.saveBtn.textContent = '修改绑定';
            el.saveBtn.classList.remove('btn-danger');
            el.saveBtn.classList.add('btn-primary');
        } else {
            el.saveBtn.textContent = '保存绑定';
            el.saveBtn.classList.remove('btn-danger');
            el.saveBtn.classList.add('btn-primary');
        }

        // 无变化时禁用保存
        const disabled = state.saving || (sameAsBefore && !nothingSelected);
        el.saveBtn.disabled = disabled;
    }

    /** 滚动到 relPath 对应的候选行并高亮闪烁 */
    function scrollToRel(rel) {
        if (!rel) return;
        const li = el.candList.querySelector(`[data-rel="${window.CSS && CSS.escape ? CSS.escape(rel) : rel.replace(/"/g, '\\"')}"]`);
        if (!li) return;
        li.scrollIntoView({ behavior: 'smooth', block: 'center' });
        li.classList.remove('pulse');
        // 触发重排，重启动画
        void li.offsetWidth;
        li.classList.add('pulse');
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

        el.clearAllBtn.addEventListener('click', () => {
            state.selectedAbs = null;
            renderList();
        });

        el.headerClose.addEventListener('click', () => {
            vscode.postMessage({ command: 'cancel' });
        });

        el.errorBannerClose.addEventListener('click', hideErrorBanner);

        el.candList.addEventListener('click', (e) => {
            const target = e.target;
            if (!(target instanceof HTMLElement)) return;

            const revealBtn = target.closest('[data-reveal]');
            if (revealBtn instanceof HTMLElement) {
                e.stopPropagation();
                const absPath = revealBtn.getAttribute('data-reveal');
                if (absPath) vscode.postMessage({ command: 'reveal', absPath });
                return;
            }

            const li = target.closest('.cand-item');
            if (!(li instanceof HTMLElement)) return;

            if (li.getAttribute('data-disabled') === '1') {
                const owner = li.querySelector('.status-tag.occupied');
                if (owner instanceof HTMLElement && owner.title) {
                    li.style.transition = 'box-shadow .3s';
                    li.style.boxShadow = '0 0 0 2px rgba(227,77,89,.35)';
                    setTimeout(() => { li.style.boxShadow = ''; }, 400);
                }
                return;
            }

            const absPath = li.getAttribute('data-abs');
            if (!absPath) return;

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

        // "当前已绑定"提示条中的定位按钮
        if (el.currentBoundLocate) {
            el.currentBoundLocate.addEventListener('click', () => {
                if (state.currentBoundAbs) {
                    vscode.postMessage({ command: 'reveal', absPath: state.currentBoundAbs });
                }
            });
        }
        // "当前已绑定"文本本身点击 → 在列表中定位
        if (el.currentBoundVal) {
            el.currentBoundVal.addEventListener('click', () => {
                if (state.currentBoundRel) scrollToRel(state.currentBoundRel);
            });
        }
        // 头部"解除绑定"按钮
        if (el.currentBoundUnbind) {
            el.currentBoundUnbind.addEventListener('click', () => {
                if (!state.currentBoundRel || state.saving) return;
                if (!confirm('确定要解除当前绑定吗？')) return;
                state.saving = true;
                renderFooter();
                vscode.postMessage({ command: 'save', selected: [] });
            });
        }

        // 空态"打开目录"按钮
        if (el.emptyOpenDirBtn) {
            el.emptyOpenDirBtn.addEventListener('click', () => {
                if (state.targetDirAbs) {
                    vscode.postMessage({ command: 'openTargetDir', absPath: state.targetDirAbs });
                }
            });
        }

        el.saveBtn.addEventListener('click', () => {
            if (state.saving || el.saveBtn.disabled) return;
            state.saving = true;
            hideErrorBanner();
            renderFooter();
            vscode.postMessage({
                command: 'save',
                selected: state.selectedAbs ? [state.selectedAbs] : [],
            });
        });

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                vscode.postMessage({ command: 'cancel' });
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                if (!el.saveBtn.disabled) el.saveBtn.click();
            }
        });
    }

    // ---------- 消息接收 ----------
    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || !msg.command) return;
        if (msg.command === 'loading') {
            setLoading(true, msg.message || '正在加载...');
            return;
        }
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
            state.targetDirAbs = p.targetDirAbs || null;
            const bound = state.candidates.find(c => c.boundToSource);
            state.selectedAbs = bound ? bound.absPath : null;
            state.initialBoundAbs = state.selectedAbs;
            setLoading(false);
            renderHeader();
            renderList();
        } else if (msg.command === 'saved') {
            state.saving = false;
            renderFooter();
        } else if (msg.command === 'saveError') {
            state.saving = false;
            showErrorBanner(msg.message || '未知错误');
            renderFooter();
        }
    });

    // ---------- 启动 ----------
    setLoading(true, '正在扫描候选文件...');
    bindEvents();
    vscode.postMessage({ command: 'ready' });
})();
