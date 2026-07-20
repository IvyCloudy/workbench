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
    if (typeof cb === 'function') {
        if (mode === 'confirm') {
            if (confirmed) cb();
        } else {
            cb(confirmed ? val : null);
        }
    }
}

// xsPrompt(title, defaultValue, onOk(value|null))
function xsPrompt(title, defaultValue, onOk) {
    var modal = document.getElementById('xsPromptModal');
    var titleEl = document.getElementById('xsPromptTitle');
    var input = document.getElementById('xsPromptInput');
    var footer = modal ? modal.querySelector('.xs-modal-footer') : null;
    if (!modal || !input) { onOk(window.prompt(title, defaultValue)); return; }
    if (titleEl) titleEl.textContent = title || '请输入';
    input.style.display = '';
    input.value = defaultValue === undefined || defaultValue === null ? '' : String(defaultValue);
    if (footer) footer.style.display = '';
    S._xsPromptMode = 'prompt';
    S._xsPromptCb = onOk;
    modal.classList.add('show');
    setTimeout(function () { input.focus(); input.select(); }, 0);
}

// xsConfirm(title, onOk())
function xsConfirm(title, onOk) {
    var modal = document.getElementById('xsPromptModal');
    var titleEl = document.getElementById('xsPromptTitle');
    var input = document.getElementById('xsPromptInput');
    if (!modal) { if (window.confirm(title)) onOk(); return; }
    if (titleEl) titleEl.textContent = title || '确认';
    if (input) input.style.display = 'none';
    S._xsPromptMode = 'confirm';
    S._xsPromptCb = onOk;
    modal.classList.add('show');
    var ok = document.getElementById('xsPromptOk');
    if (ok) setTimeout(function () { ok.focus(); }, 0);
}

