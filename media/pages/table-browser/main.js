// ============ 表格浏览器页面 ============
import { Table, FileTree, Loading } from '../common/index.js';

const vscode = acquireVsCodeApi();

(function () {
    // ============ 组件初始化 ============
    const fileTree = new FileTree('#fileTreeBody', {
        onFileClick: (filePath) => loadCsvFile(filePath)
    });

    const table = new Table('#csvBody', { selectable: true, resizable: true });
    const loading = new Loading('#csvBody');

    const $ = (id) => document.getElementById(id);
    const csvFileName = $('csvFileName');
    const csvActions = $('csvActions');
    const sendBtn = $('sendSelectedBtn');
    const selectAllBtn = $('selectAllBtn');
    const selectNoneBtn = $('selectNoneBtn');
    const selectedRowCountEl = $('selectedRowCount');
    const toastEl = $('toast');

    // ============ 选中数变化时同步按钮状态 ============
    table.onSelectionChange = () => {
        const count = table.getSelectedCount();
        selectedRowCountEl.textContent = count;
        sendBtn.disabled = count === 0;
    };

    // ============ 数据请求函数 ============
    function loadWorkspaceFiles() {
        vscode.postMessage({ command: 'fetchWorkspaceFiles' });
    }

    function loadCsvFile(filePath) {
        loading.show('加载 CSV 文件...');
        csvFileName.textContent = filePath.split(/[/\\]/).pop() || '';
        vscode.postMessage({ command: 'readCsvFile', filePath });
    }

    function showToast(message, type = 'info') {
        if (!toastEl) return;
        toastEl.textContent = message;
        toastEl.className = `toast toast-${type}`;
        toastEl.style.display = 'block';
        setTimeout(() => {
            toastEl.style.display = 'none';
        }, 3000);
    }

    // ============ 事件绑定 ============
    sendBtn?.addEventListener('click', () => {
        const selected = table.getSelectedRows();
        if (selected.length === 0) {
            showToast('请先选择要发送的数据', 'error');
            return;
        }
        vscode.postMessage({
            command: 'sendSelectedData',
            selectedRows: selected,
            headers: table.data?.headers || []
        });
    });

    selectAllBtn?.addEventListener('click', () => table.selectAll());
    selectNoneBtn?.addEventListener('click', () => table.unselectAll());

    // ============ 消息处理 ============
    window.addEventListener('message', function (event) {
        const msg = event.data;
        switch (msg.command) {
            case 'workspaceFiles':
                fileTree.render(msg.data);
                break;

            case 'csvData':
                if (msg.error) {
                    table.showError(msg.error);
                    csvActions.style.display = 'none';
                } else {
                    table.render(msg.data);
                    csvActions.style.display = msg.data?.rows?.length > 0 ? 'flex' : 'none';
                    selectedRowCountEl.textContent = '0';
                    sendBtn.disabled = true;
                }
                break;

            case 'sendResult':
                if (msg.success) {
                    showToast(msg.message || '数据发送成功', 'success');
                } else {
                    showToast(msg.message || '发送失败', 'error');
                }
                break;
        }
    });

    // ============ 启动 ============
    loadWorkspaceFiles();
    console.log('[TableBrowser] 页面已加载');
})();