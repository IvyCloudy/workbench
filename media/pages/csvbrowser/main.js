(function () {
    var vscode = acquireVsCodeApi();

    // ============ 全局变量 ============
    var currentCsvData = null;
    var selectedRows = new Set();
    var currentFilePath = null;

    // ============ Toast 提示 ============
    function showToast(message, type) {
        var toast = document.getElementById('toast');
        if (!toast) return;
        toast.textContent = message;
        toast.className = 'toast show ' + (type || '');
        setTimeout(function () {
            toast.classList.remove('show');
        }, 3000);
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;')
                  .replace(/'/g, '&#039;');
    }

    // ============ 文件树渲染 ============
    function renderFileTree(files) {
        var container = document.getElementById('fileTreeBody');
        if (!container) return;

        if (!files || files.length === 0) {
            container.innerHTML = '<div class="file-tree-empty">未找到"测试任务"目录或目录下没有CSV文件<br><br>提示：请在工作区根目录下创建"测试任务"目录，并在其中放置CSV文件</div>';
            return;
        }

        var html = '';
        files.forEach(function (folder) {
            html += '<div class="file-tree-node folder" data-path="' + escapeHtml(folder.path) + '">';
            html += '<span class="icon">&#128193;</span>';
            html += '<span class="name">' + escapeHtml(folder.name) + '</span>';
            html += '</div>';

            if (folder.children && folder.children.length > 0) {
                folder.children.forEach(function (subFolder) {
                    html += '<div class="file-tree-node folder" style="padding-left:24px" data-path="' + escapeHtml(subFolder.path) + '">';
                    html += '<span class="icon">&#128194;</span>';
                    html += '<span class="name">' + escapeHtml(subFolder.name) + '</span>';
                    html += '</div>';

                    if (subFolder.children && subFolder.children.length > 0) {
                        subFolder.children.forEach(function (file) {
                            html += '<div class="file-tree-node file" style="padding-left:40px" data-path="' + escapeHtml(file.path) + '">';
                            html += '<span class="icon">&#128196;</span>';
                            html += '<span class="name">' + escapeHtml(file.name) + '</span>';
                            html += '</div>';
                        });
                    }
                });
            }
        });

        container.innerHTML = html;

        // 绑定点击事件
        container.querySelectorAll('.file-tree-node.file').forEach(function (node) {
            node.addEventListener('click', function () {
                var path = node.getAttribute('data-path');
                container.querySelectorAll('.file-tree-node.file').forEach(function (n) {
                    n.classList.remove('active');
                });
                node.classList.add('active');
                loadCsvFile(path);
            });
        });
    }

    // ============ 加载CSV文件 ============
    function loadCsvFile(filePath) {
        currentFilePath = filePath;
        selectedRows.clear();
        updateSelectedCount();

        var csvBody = document.getElementById('csvBody');
        var csvFileName = document.getElementById('csvFileName');
        var csvActions = document.getElementById('csvActions');

        if (csvBody) {
            csvBody.innerHTML = '<div class="csv-loading">加载中...</div>';
        }
        if (csvFileName) {
            csvFileName.textContent = '';
        }
        if (csvActions) {
            csvActions.style.display = 'none';
        }

        vscode.postMessage({ command: 'readCsvFile', filePath: filePath });
    }

    // ============ 渲染CSV表格 ============
    function renderCsvTable(data) {
        var csvBody = document.getElementById('csvBody');
        var csvFileName = document.getElementById('csvFileName');
        var csvActions = document.getElementById('csvActions');

        if (!csvBody) return;

        currentCsvData = data;
        selectedRows.clear();

        if (!data || !data.rows || data.rows.length === 0) {
            csvBody.innerHTML = '<div class="csv-empty"><div class="icon">&#128196;</div><div>CSV文件为空</div></div>';
            return;
        }

        var fileName = data.fileName || '';
        if (csvFileName) {
            csvFileName.textContent = fileName;
        }
        if (csvActions) {
            csvActions.style.display = 'flex';
        }

        var headers = data.headers || [];
        var rows = data.rows || [];

        var html = '<table class="csv-table"><thead><tr>';
        html += '<th class="checkbox"><input type="checkbox" id="selectAll"></th>';
        headers.forEach(function (h) {
            html += '<th>' + escapeHtml(h) + '</th>';
        });
        html += '</tr></thead><tbody>';

        rows.forEach(function (row, idx) {
            html += '<tr data-index="' + idx + '">';
            html += '<td class="checkbox"><input type="checkbox" class="row-checkbox" data-index="' + idx + '"></td>';
            row.forEach(function (cell) {
                html += '<td title="' + escapeHtml(cell) + '">' + escapeHtml(cell) + '</td>';
            });
            html += '</tr>';
        });

        html += '</tbody></table>';
        csvBody.innerHTML = html;

        // 绑定事件
        var selectAll = document.getElementById('selectAll');
        if (selectAll) {
            selectAll.addEventListener('change', function () {
                var checked = this.checked;
                document.querySelectorAll('.row-checkbox').forEach(function (cb) {
                    cb.checked = checked;
                    var idx = parseInt(cb.getAttribute('data-index'), 10);
                    if (checked) {
                        selectedRows.add(idx);
                    } else {
                        selectedRows.delete(idx);
                    }
                });
                updateSelectedCount();
                updateRowStyles();
            });
        }

        document.querySelectorAll('.row-checkbox').forEach(function (cb) {
            cb.addEventListener('change', function () {
                var idx = parseInt(this.getAttribute('data-index'), 10);
                if (this.checked) {
                    selectedRows.add(idx);
                } else {
                    selectedRows.delete(idx);
                }
                updateSelectedCount();
                updateRowStyles();
                if (selectAll) {
                    var allCheckboxes = document.querySelectorAll('.row-checkbox');
                    var checkedCount = document.querySelectorAll('.row-checkbox:checked').length;
                    selectAll.checked = checkedCount === allCheckboxes.length;
                    selectAll.indeterminate = checkedCount > 0 && checkedCount < allCheckboxes.length;
                }
            });
        });
    }

    function updateSelectedCount() {
        var countEl = document.getElementById('selectedRowCount');
        var sendBtn = document.getElementById('sendSelectedBtn');
        if (countEl) {
            countEl.textContent = selectedRows.size;
        }
        if (sendBtn) {
            sendBtn.disabled = selectedRows.size === 0;
        }
    }

    function updateRowStyles() {
        document.querySelectorAll('.csv-table tbody tr').forEach(function (tr) {
            var idx = parseInt(tr.getAttribute('data-index'), 10);
            if (selectedRows.has(idx)) {
                tr.classList.add('selected');
            } else {
                tr.classList.remove('selected');
            }
        });
    }

    // ============ 发送选中数据 ============
    function sendSelectedData() {
        if (selectedRows.size === 0) {
            showToast('请先勾选要发送的数据', 'error');
            return;
        }

        if (!currentCsvData) {
            showToast('没有可发送的数据', 'error');
            return;
        }

        var rowsToSend = [];
        selectedRows.forEach(function (idx) {
            rowsToSend.push(currentCsvData.rows[idx]);
        });

        vscode.postMessage({
            command: 'sendSelectedData',
            selectedRows: rowsToSend,
            headers: currentCsvData.headers
        });
    }

    // ============ 初始化 ============
    document.addEventListener('DOMContentLoaded', function () {
        // 请求工作区文件
        vscode.postMessage({ command: 'fetchWorkspaceFiles' });

        // 绑定按钮事件
        var sendBtn = document.getElementById('sendSelectedBtn');
        if (sendBtn) {
            sendBtn.addEventListener('click', sendSelectedData);
        }

        var selectAllBtn = document.getElementById('selectAllBtn');
        if (selectAllBtn) {
            selectAllBtn.addEventListener('click', function () {
                document.querySelectorAll('.row-checkbox').forEach(function (cb) {
                    cb.checked = true;
                    selectedRows.add(parseInt(cb.getAttribute('data-index'), 10));
                });
                var selectAll = document.getElementById('selectAll');
                if (selectAll) selectAll.checked = true;
                updateSelectedCount();
                updateRowStyles();
            });
        }

        var selectNoneBtn = document.getElementById('selectNoneBtn');
        if (selectNoneBtn) {
            selectNoneBtn.addEventListener('click', function () {
                document.querySelectorAll('.row-checkbox').forEach(function (cb) {
                    cb.checked = false;
                });
                selectedRows.clear();
                var selectAll = document.getElementById('selectAll');
                if (selectAll) {
                    selectAll.checked = false;
                    selectAll.indeterminate = false;
                }
                updateSelectedCount();
                updateRowStyles();
            });
        }
    });

    // ============ 消息处理 ============
    window.addEventListener('message', function (event) {
        var msg = event.data;
        switch (msg.command) {
            case 'workspaceFiles':
                renderFileTree(msg.data);
                break;
            case 'csvData':
                if (msg.error) {
                    showToast(msg.error, 'error');
                    var csvBody = document.getElementById('csvBody');
                    if (csvBody) csvBody.innerHTML = '<div class="csv-empty"><div class="icon">&#128196;</div><div>' + escapeHtml(msg.error) + '</div></div>';
                } else {
                    renderCsvTable(msg.data);
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
})();
