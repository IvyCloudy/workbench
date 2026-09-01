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
    S._xsPromptCancelCb = null;
    S._xsPromptMode = null;
    // 清理标题/消息/类型样式（含富文本分支与自定义宽度，避免污染后续弹窗）
    var msgEl = document.getElementById('xsPromptMessage');
    if (msgEl) { msgEl.style.display = 'none'; msgEl.textContent = ''; msgEl.innerHTML = ''; }
    var dlg = modal ? modal.querySelector('.xs-modal-dialog') : null;
    if (dlg) dlg.style.width = '';
    var header = document.getElementById('xsPromptHeader');
    if (header) {
        header.classList.remove('xs-prompt-type-warning', 'xs-prompt-type-danger');
    }
    // 类型 class 加在 overlay 上，方便用后代选择器统一覆盖 header / 主按钮 等
    modal.classList.remove('xs-prompt-type-warning', 'xs-prompt-type-danger');
    if (typeof cb === 'function') {
        if (mode === 'confirm') {
            if (confirmed) cb();
            else { var ccb = S._xsPromptCancelCb; if (typeof ccb === 'function') ccb(); }
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
            // html：可选的富文本内容（如"需确认案例"表格）。存在时优先于 message 渲染，
            // 由调用方自行保证内容已转义（见 escapeHtml），避免 innerHTML 注入风险。
            html: titleOrOpts.html || '',
            // width：弹窗宽度（如 '620px'），用于承载表格等宽内容；缺省沿用 HTML 里的 380px
            width: titleOrOpts.width || '',
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
        html: '',
        width: '',
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
    // 宽度：由调用方按需加宽（承载表格等宽内容），缺省时交还 HTML 默认宽度
    var dialog = modal ? modal.querySelector('.xs-modal-dialog') : null;
    if (dialog) {
        if (opts.width) dialog.style.width = opts.width;
        else dialog.style.width = '';
    }
    if (msgEl) {
        if (opts.html) {
            // 富文本分支（表格等）：调用方负责转义，此处仅做渲染
            msgEl.innerHTML = opts.html;
            msgEl.style.display = '';
        } else if (opts.message) {
            msgEl.textContent = opts.message;
            msgEl.style.display = '';
        } else {
            msgEl.textContent = '';
            msgEl.innerHTML = '';
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

// xsConfirm(optsOrTitle, onOk(), onCancel?)
//   optsOrTitle 支持字符串（旧）或 { title, message, type, okText, cancelText }
//   onOk: 用户点「确定」时执行；onCancel（可选）: 用户点「取消/关闭」时执行
function xsConfirm(optsOrTitle, onOk, onCancel) {
    var opts = _normalizeXsPromptArgs(optsOrTitle, undefined, onOk);
    var cb = opts._legacyOnOk || onOk;
    var modal = document.getElementById('xsPromptModal');
    var input = document.getElementById('xsPromptInput');
    if (!modal) { if (window.confirm(opts.title)) { if (cb) cb(); } else if (onCancel) { onCancel(); } return; }
    _applyXsPromptConfig(modal, opts);
    if (input) input.style.display = 'none';
    S._xsPromptMode = 'confirm';
    S._xsPromptCb = cb;
    S._xsPromptCancelCb = (typeof onCancel === 'function') ? onCancel : null;
    modal.classList.add('show');
    var ok = document.getElementById('xsPromptOk');
    if (ok) setTimeout(function () { ok.focus(); }, 0);
}



