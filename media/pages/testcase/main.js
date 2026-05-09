(function () {
    var COLUMNS_ORDER = [
        'testCaseNo',
        'testCaseName',
        'testCasePath',
        'description',
        'preCondition',
        'testCasePriority',
        'testCaseDes',
        'expected',
        'testType',
        'type',
        'designer'
    ];

    var COLUMN_NAMES = {
        testCaseNo: '编号',
        testCaseName: '名称',
        testCasePath: '路径',
        description: '描述',
        preCondition: '前置条件',
        testCasePriority: '优先级',
        testCaseDes: '案例描述',
        expected: '预期结果',
        testType: '执行方式',
        type: '案例类型',
        designer: '设计人'
    };

    var COLUMN_RENDER = {
        testCaseNo: function (v) { return '<span class="case-code">' + escapeHtml(v) + '</span>'; },
        testCaseName: function (v, row) {
            var path = row.testCasePath || '';
            return '<div class="case-name-cell"><div class="name" title="' + escapeAttr(v) + '">' + escapeHtml(v) + '</div>' +
                (path ? '<div class="path" title="' + escapeAttr(path) + '">' + escapeHtml(path) + '</div>' : '') + '</div>';
        },
        testCasePath: function (v) { return ellipsisCell(v, 20); },
        testCasePriority: function (v) {
            var cls = v === '高' ? 'pri-high' : v === '中' ? 'pri-mid' : 'pri-low';
            return '<span class="priority ' + cls + '">' + escapeHtml(v) + '</span>';
        },
        testType: function (v) {
            var map = { '手工': 'tag-blue', '自动化': 'tag-green', '半自动化': 'tag-orange' };
            return '<span class="case-type-tag ' + (map[v] || '') + '">' + escapeHtml(v) + '</span>';
        },
        type: function (v) {
            var map = { '流程类': 'tag-purple', '功能点类': 'tag-blue', '界面类': 'tag-blue', '安全类': 'tag-red', '批处理类': 'tag-orange', '报文接口类': 'tag-orange', '可用性检查类': 'tag-green', '数据仓库类': 'tag-purple', '算法类': 'tag-cyan', '报表统计类': 'tag-cyan' };
            return '<span class="case-type-tag ' + (map[v] || '') + '">' + escapeHtml(v) + '</span>';
        },
        designer: function (v) {
            var name = v || '';
            var initial = name.charAt(0);
            var colors = ['#0052d9', '#2ba471', '#7b3fe4', '#e37318', '#d64b8a', '#08979c', '#d48806', '#c41d7f', '#1d39c4', '#389e0d'];
            var color = colors[initial.charCodeAt(0) % colors.length];
            return '<span class="owner-cell">' +
                '<span class="avatar-mini" style="background:' + color + '">' + escapeHtml(initial) + '</span>' +
                escapeHtml(name) +
                '</span>';
        },
        description: function (v) { return ellipsisCell(v, 20); },
        preCondition: function (v) { return ellipsisCell(v, 20); },
        expected: function (v) { return ellipsisCell(v, 20); },
        testCaseDes: function (v) { return ellipsisCell(v, 20); }
    };

    var infoTaskName = document.getElementById('infoTaskName');
    var infoSubTaskName = document.getElementById('infoSubTaskName');
    var infoPhaseName = document.getElementById('infoPhaseName');
    var loadingEl = document.getElementById('loading');
    var errorEl = document.getElementById('error');
    var tableWrap = document.getElementById('tableWrap');
    var paginationEl = document.getElementById('pagination');
    var filterTestCaseNo = document.getElementById('filterTestCaseNo');
    var filterTestCaseName = document.getElementById('filterTestCaseName');
    var filterTestCasePath = document.getElementById('filterTestCasePath');
    var filterPriority = document.getElementById('filterPriority');
    var filterTestType = document.getElementById('filterTestType');
    var filterType = document.getElementById('filterType');
    var resetBtn = document.getElementById('resetBtn');

    var testTaskNo = '';
    var subTestTaskName = '';
    var testPhaseName = '';
    var currentPage = 1;
    var currentPageSize = 20;
    var totalRecords = 0;
    var totalPagesCount = 0;
    var infoBarSet = false;

    function ellipsisCell(v, maxLen) {
        var s = v || '';
        var display = s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
        display = escapeHtml(display).replace(/\n/g, '<br>');
        return '<span class="case-desc" title="' + escapeAttr(s) + '">' + display + '</span>';
    }

    function getFilters() {
        return {
            testCaseNo: filterTestCaseNo.value.trim(),
            testCaseName: filterTestCaseName.value.trim(),
            testCasePath: filterTestCasePath.value.trim(),
            testCasePriority: filterPriority.value,
            testType: filterTestType.value,
            type: filterType.value
        };
    }

    function search(pageNum) {
        doQuery(testTaskNo, subTestTaskName, testPhaseName, currentPageSize, pageNum, getFilters());
    }

    function doQuery(testTaskNo, subTestTaskName, testPhaseName, pageSize, pageNum, filters) {
        if (!testTaskNo || !subTestTaskName) {
            showError('未获取到测试任务信息');
            return;
        }
        currentPage = pageNum || 1;
        currentPageSize = pageSize;
        showLoading();
        HttpClient.query({
            currentPage: currentPage,
            pageSize: pageSize,
            testCaseNo: filters.testCaseNo,
            testCaseName: filters.testCaseName,
            testCasePath: filters.testCasePath,
            testCasePriority: filters.testCasePriority,
            testType: filters.testType,
            type: filters.type
        });
    }

    filterTestCaseNo.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') search(1);
    });
    filterTestCaseName.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') search(1);
    });
    filterTestCasePath.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') search(1);
    });
    filterPriority.addEventListener('change', function () { search(1); });
    filterTestType.addEventListener('change', function () { search(1); });
    filterType.addEventListener('change', function () { search(1); });
    resetBtn.addEventListener('click', function () {
        filterTestCaseNo.value = '';
        filterTestCaseName.value = '';
        filterTestCasePath.value = '';
        filterPriority.value = '';
        filterTestType.value = '';
        filterType.value = '';
        search(1);
    });

    window.addEventListener('message', function (event) {
        var msg = event.data;
        switch (msg.command) {
            case 'init':
                if (msg.testTaskNo) {
                    testTaskNo = msg.testTaskNo;
                    infoTaskName.innerHTML = '<strong>' + escapeHtml(msg.testTaskNo) + '</strong>';
                }
                if (msg.subTestTaskName) {
                    subTestTaskName = msg.subTestTaskName;
                    infoSubTaskName.textContent = msg.subTestTaskName;
                }
                if (msg.testPhaseName) {
                    testPhaseName = msg.testPhaseName;
                    infoPhaseName.textContent = msg.testPhaseName;
                }
                if (msg.pageSize) {
                    currentPageSize = parseInt(msg.pageSize, 10) || 20;
                }
                if (testTaskNo && subTestTaskName) {
                    search(1);
                }
                break;
            case 'loading':
                showLoading();
                break;
            case 'showData':
                if (!infoBarSet && msg.data && msg.data.length > 0) {
                    var first = msg.data[0];
                    if (first.testTaskName) infoTaskName.innerHTML = '<strong>' + escapeHtml(first.testTaskName) + '</strong>';
                    if (first.testPhaseName) infoPhaseName.textContent = first.testPhaseName;
                    infoBarSet = true;
                }
                renderTable(msg.data, msg.total, msg.currentPage, msg.pageSize);
                break;
            case 'showError':
                showError(msg.message);
                break;
        }
    });

    HttpClient.postMessage({ command: 'ready' });

    function showLoading() {
        loadingEl.classList.remove('hidden');
        errorEl.classList.add('hidden');
        tableWrap.classList.add('hidden');
        paginationEl.classList.add('hidden');
    }

    function showError(msg) {
        errorEl.textContent = msg;
        errorEl.classList.remove('hidden');
        loadingEl.classList.add('hidden');
        tableWrap.classList.add('hidden');
        paginationEl.classList.add('hidden');
    }

    function renderTable(data, total, pageNum, pageSize) {
        loadingEl.classList.add('hidden');
        errorEl.classList.add('hidden');

        currentPage = pageNum || 1;
        currentPageSize = parseInt(pageSize, 10) || 20;
        totalRecords = total || (data ? data.length : 0);
        totalPagesCount = Math.ceil(totalRecords / currentPageSize) || 1;

        if (!data || data.length === 0) {
            tableWrap.innerHTML = '<div class="empty">暂无数据</div>';
            tableWrap.classList.remove('hidden');
            paginationEl.classList.add('hidden');
            return;
        }

        var columns = COLUMNS_ORDER.filter(function (col) { return data[0][col] !== undefined; });
        var html = '<table><thead><tr>';
        for (var i = 0; i < columns.length; i++) {
            html += '<th>' + escapeHtml(COLUMN_NAMES[columns[i]] || columns[i]) + '</th>';
        }
        html += '</tr></thead><tbody>';
        for (var r = 0; r < data.length; r++) {
            html += '<tr>';
            for (var c = 0; c < columns.length; c++) {
                var col = columns[c];
                var val = data[r][col] !== null && data[r][col] !== undefined ? String(data[r][col]) : '';
                var render = COLUMN_RENDER[col];
                html += '<td>' + (render ? render(val, data[r]) : escapeHtml(val)) + '</td>';
            }
            html += '</tr>';
        }
        html += '</tbody></table>';
        tableWrap.innerHTML = html;
        tableWrap.classList.remove('hidden');

        renderPagination();
    }

    function renderPagination() {
        var p = currentPage;
        var tp = totalPagesCount;
        var html = '<span class="pg-total">共 ' + totalRecords + ' 条</span>';

        html += '<button class="page-btn" ' + (p <= 1 ? 'disabled' : '') + ' data-go="1">&#171;</button>';
        html += '<button class="page-btn" ' + (p <= 1 ? 'disabled' : '') + ' data-go="prev">&#8249;</button>';

        var pages = [];
        for (var i = 1; i <= tp; i++) {
            if (i === 1 || i === tp || (i >= p - 2 && i <= p + 2)) pages.push(i);
            else if (pages[pages.length - 1] !== '...') pages.push('...');
        }
        for (var j = 0; j < pages.length; j++) {
            var pg = pages[j];
            if (pg === '...') {
                html += '<span style="padding:0 4px;color:#999">···</span>';
            } else {
                html += '<button class="page-btn ' + (pg === p ? 'active' : '') + '" data-go="' + pg + '">' + pg + '</button>';
            }
        }

        html += '<button class="page-btn" ' + (p >= tp ? 'disabled' : '') + ' data-go="next">&#8250;</button>';
        html += '<button class="page-btn" ' + (p >= tp ? 'disabled' : '') + ' data-go="' + tp + '">&#187;</button>';

        html += '<span class="pg-jump">第 <input id="gotoPage" type="number" min="1" value="' + p + '" /> / ' + tp + ' 页</span>';

        html += '<select class="page-size" id="pageSizeSelect">' +
            [10, 20, 50, 100, 200].map(function (n) {
                return '<option value="' + n + '" ' + (n === currentPageSize ? 'selected' : '') + '>' + n + ' 条/页</option>';
            }).join('') + '</select>';

        paginationEl.innerHTML = html;
        paginationEl.classList.remove('hidden');
    }

    function navigatePage(page) {
        if (page < 1 || page > totalPagesCount || page === currentPage) return;
        currentPage = page;
        search(page);
    }

    paginationEl.addEventListener('click', function (e) {
        var btn = e.target.closest('.page-btn');
        if (btn && !btn.disabled) {
            var go = btn.getAttribute('data-go');
            if (go === 'prev') navigatePage(currentPage - 1);
            else if (go === 'next') navigatePage(currentPage + 1);
            else navigatePage(parseInt(go, 10));
        }
    });

    paginationEl.addEventListener('keydown', function (e) {
        if (e.target.id === 'gotoPage' && e.key === 'Enter') {
            var page = parseInt(e.target.value, 10);
            if (isNaN(page) || page < 1) page = 1;
            if (page > totalPagesCount) page = totalPagesCount;
            navigatePage(page);
        }
    });

    paginationEl.addEventListener('change', function (e) {
        if (e.target.id === 'pageSizeSelect') {
            currentPageSize = parseInt(e.target.value, 10);
            currentPage = 1;
            search(1);
        }
    });

    function escapeHtml(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function escapeAttr(str) {
        return String(str == null ? '' : str).replace(/[&"]/g, function (c) {
            return c === '&' ? '&amp;' : '&quot;';
        }).replace(/\n/g, '&#10;');
    }
})();
