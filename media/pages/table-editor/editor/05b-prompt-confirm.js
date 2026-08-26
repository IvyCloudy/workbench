/* =============================================================================
 * 05b-prompt-confirm.js  —— 通用 Prompt / Confirm 弹窗
 * -----------------------------------------------------------------------------
 * 由原 05-modals.js 拆分而来，替代受 vscode webview sandbox 限制的
 * 原生 window.prompt / window.confirm。
 *
 *   bindXsPrompt / isXsPromptOpen / closeXsPrompt / xsPrompt / xsConfirm
 * ========================================================================== */

// ==================== 通用 Prompt / Confirm 弹窗 ====================
// 替代受 vscode webview sandbox 限制的 window.prompt / window.confirm
function bindXsPrompt() {
    if (S._xsPromptBound) return;
    S._xsPromptBound = true;
    var modal = document.getElementById('xsPromptModal');
    var ok = document.getElementById('xsPromptOk');
    var cancel = document.getElementById('xsPromptCancel');
    var close = document.getElementById('xsPromptClose');
    var input = document.getElementById('xsPromptInput');
    if (!modal || !ok || !cancel || !close) return;
    ok.addEventListener('click', function () { closeXsPrompt(true); });
    cancel.addEventListener('click', function () { closeXsPrompt(false); });
    close.addEventListener('click', function () { closeXsPrompt(false); });
    if (input) input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); closeXsPrompt(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); closeXsPrompt(false); }
        ev.stopPropagation();
    });
    // 复用公共粘贴兜底（webview 沙箱下原生 Ctrl/Cmd+V 偶发失效）
    if (input && typeof attachPasteFallback === 'function') attachPasteFallback(input);
}

function isXsPromptOpen() {
    var modal = document.getElementById('xsPromptModal');
    return !!(modal && modal.classList.contains('show'));
}

function closeXsPrompt(confirmed) {
    var modal = document.getElementById('xsPromptModal');
    if (!modal) return;
    modal.classList.remove('show');
    var input = document.getElementById('xsPromptInput');
    var cb = S._xsPromptCb;
    var mode = S._xsPromptMode;
    var val = input ? input.value : '';
    S._xsPromptCb = null;
    S._xsPromptMode = null;
    // 清理标题/消息/类型样式
    var msgEl = document.getElementById('xsPromptMessage');
    if (msgEl) { msgEl.style.display = 'none'; msgEl.textContent = ''; }
    var header = document.getElementById('xsPromptHeader');
    if (header) {
        header.classList.remove('xs-prompt-type-warning', 'xs-prompt-type-danger');
    }
    // 类型 class 加在 overlay 上，方便用后代选择器统一覆盖 header / 主按钮 等
    modal.classList.remove('xs-prompt-type-warning', 'xs-prompt-type-danger');
    if (typeof cb === 'function') {
        if (mode === 'confirm_any') {
            // 无论确认或取消都把布尔结果传回（用于"文件删除"等需要回传明确决策的远程确认）
            cb(!!confirmed);
        } else if (mode === 'confirm') {
            if (confirmed) cb();
        } else {
            cb(confirmed ? val : null);
        }
    }
}

/**
 * 解析弹窗参数：兼容旧版「字符串签名」与新版「配置对象签名」。
 *   - 字符串签名: ('标题', ...)
 *   - 对象签名: ({ title, message, type, okText, cancelText }, ...)
 * 返回标准化后的 { title, message, type, okText, cancelText }。
 */
function _normalizeXsPromptArgs(titleOrOpts, legacyDefaultValue, legacyOnOk) {
    if (titleOrOpts && typeof titleOrOpts === 'object' && !Array.isArray(titleOrOpts)) {
        return {
            title: titleOrOpts.title || '确认',
            message: titleOrOpts.message || '',
            type: titleOrOpts.type || 'info', // 'info' | 'warning' | 'danger'
            okText: titleOrOpts.okText || '确定',
            cancelText: titleOrOpts.cancelText || '取消',
            // 给调用方补回 onOk 占位，调用方仍然按 xsPrompt(opts, defaultValue, onOk) 形式传入
            _legacyDefaultValue: legacyDefaultValue,
            _legacyOnOk: legacyOnOk,
        };
    }
    return {
        title: typeof titleOrOpts === 'string' ? titleOrOpts : '请输入',
        message: '',
        type: 'info',
        okText: '确定',
        cancelText: '取消',
        _legacyDefaultValue: legacyDefaultValue,
        _legacyOnOk: legacyOnOk,
    };
}

/** 内部：把标准化参数渲染到 modal 元素上 */
function _applyXsPromptConfig(modal, opts) {
    if (!modal) return;
    var titleEl = document.getElementById('xsPromptTitle');
    var msgEl = document.getElementById('xsPromptMessage');
    var header = document.getElementById('xsPromptHeader');
    var okBtn = document.getElementById('xsPromptOk');
    var cancelBtn = document.getElementById('xsPromptCancel');

    if (titleEl) titleEl.textContent = opts.title;
    if (okBtn) okBtn.textContent = opts.okText;
    if (cancelBtn) cancelBtn.textContent = opts.cancelText;

    if (header) {
        header.classList.remove('xs-prompt-type-warning', 'xs-prompt-type-danger');
        if (opts.type === 'warning') header.classList.add('xs-prompt-type-warning');
        else if (opts.type === 'danger') header.classList.add('xs-prompt-type-danger');
    }
    // 同时把类型 class 挂到 overlay 上，便于通过后代选择器覆盖 footer 主按钮等
    modal.classList.remove('xs-prompt-type-warning', 'xs-prompt-type-danger');
    if (opts.type === 'warning') modal.classList.add('xs-prompt-type-warning');
    else if (opts.type === 'danger') modal.classList.add('xs-prompt-type-danger');
    if (msgEl) {
        if (opts.message) {
            msgEl.textContent = opts.message;
            msgEl.style.display = '';
        } else {
            msgEl.textContent = '';
            msgEl.style.display = 'none';
        }
    }
}

// xsPrompt(optsOrTitle, defaultValue, onOk(value|null))
//   optsOrTitle 支持字符串（旧）或 { title, message, type, okText, cancelText }
function xsPrompt(optsOrTitle, defaultValue, onOk) {
    var opts = _normalizeXsPromptArgs(optsOrTitle, defaultValue, onOk);
    var modal = document.getElementById('xsPromptModal');
    var input = document.getElementById('xsPromptInput');
    var footer = modal ? modal.querySelector('.xs-modal-footer') : null;
    var cb = opts._legacyOnOk || onOk;
    var def = opts._legacyDefaultValue !== undefined ? opts._legacyDefaultValue : defaultValue;
    if (!modal || !input) { cb(window.prompt(opts.title, def)); return; }
    _applyXsPromptConfig(modal, opts);
    input.style.display = '';
    input.value = def === undefined || def === null ? '' : String(def);
    if (footer) footer.style.display = '';
    S._xsPromptMode = 'prompt';
    S._xsPromptCb = cb;
    modal.classList.add('show');
    setTimeout(function () { input.focus(); input.select(); }, 0);
}

// xsConfirm(optsOrTitle, onOk())
//   optsOrTitle 支持字符串（旧）或 { title, message, type, okText, cancelText }
function xsConfirm(optsOrTitle, onOk) {
    var opts = _normalizeXsPromptArgs(optsOrTitle, undefined, onOk);
    var cb = opts._legacyOnOk || onOk;
    var modal = document.getElementById('xsPromptModal');
    var input = document.getElementById('xsPromptInput');
    if (!modal) { if (window.confirm(opts.title)) cb(); return; }
    _applyXsPromptConfig(modal, opts);
    if (input) input.style.display = 'none';
    S._xsPromptMode = 'confirm';
    S._xsPromptCb = cb;
    modal.classList.add('show');
    var ok = document.getElementById('xsPromptOk');
    if (ok) setTimeout(function () { ok.focus(); }, 0);
}

/**
 * 与 xsConfirm 类似，但无论确认或取消都把布尔结果通过 onResult(boolean) 回传。
 * 用于"文件删除"等场景：确认结果需要回传给扩展端（而不是只在确认时执行回调）。
 */
function xsConfirmWithCancel(optsOrTitle, onResult) {
    var opts = _normalizeXsPromptArgs(optsOrTitle, undefined, undefined);
    var modal = document.getElementById('xsPromptModal');
    if (!modal) { onResult(!!window.confirm(opts.title)); return; }
    _applyXsPromptConfig(modal, opts);
    var input = document.getElementById('xsPromptInput');
    if (input) input.style.display = 'none';
    S._xsPromptMode = 'confirm_any';
    S._xsPromptCb = onResult;
    modal.classList.add('show');
    var ok = document.getElementById('xsPromptOk');
    if (ok) setTimeout(function () { ok.focus(); }, 0);
}

