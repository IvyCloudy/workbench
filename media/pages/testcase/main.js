(function () {
    var vscode = acquireVsCodeApi();

    window.HttpClient = {
        postMessage: function (msg) {
            vscode.postMessage(msg);
        },
        query: function (params) {
            vscode.postMessage({
                command: 'query',
                currentPage: params.currentPage,
                pageSize: params.pageSize,
                testCaseNo: params.testCaseNo,
                testCaseName: params.testCaseName,
                testCasePath: params.testCasePath,
                testCasePriority: params.testCasePriority,
                testType: params.testType,
                type: params.type,
                testTaskNo: params.testTaskNo,
                subTestTaskName: params.subTestTaskName,
                testPhaseName: params.testPhaseName
            });
        }
    };

    var allData = [];
    var loadingPage = 0;
    var pageSize = 15;
    var hasMore = true;
    var isLoading = false;

    var COLUMNS_ORDER = [
        'testCaseNo', 'testCaseName', 'testCasePath', 'testCaseDes',
        'preCondition', 'testCasePriority', 'description', 'expected',
        'testType', 'type', 'designer'
    ];

    var COLUMN_NAMES = {
        testCaseNo: '编号', testCaseName: '名称', testCasePath: '路径',
        description: '案例描述', preCondition: '前置条件', testCasePriority: '优先级',
        testCaseDes: '描述', expected: '预期结果', testType: '执行方式',
        type: '案例类型', designer: '设计人'
    };

    var COLUMN_RENDER = {
        testCaseNo: function (v) { return '<span class="case-code">' + escapeHtml(v) + '</span>'; },
        testCaseName: function (v) {
            return '<span title="' + escapeAttr(v) + '">' + escapeHtml(v) + '</span>';
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
                '<span class="cell-trunc-name">' + escapeHtml(name) + '</span></span>';
        },
        description: function (v) { return ellipsisCell(v, 20); },
        preCondition: function (v) { return ellipsisCell(v, 20); },
        expected: function (v) { return htmlCell(v, 20); },
        testCaseDes: function (v) { return htmlCell(v, 20); }
    };

    var infoTaskName = document.getElementById('infoTaskName');
    var infoSubTaskName = document.getElementById('infoSubTaskName');
    var infoPhaseName = document.getElementById('infoPhaseName');
    var loadingEl = document.getElementById('loading');
    var errorEl = document.getElementById('error');
    var tableWrap = document.getElementById('tableWrap');
    var loadMoreEl = document.getElementById('loadMore');
    var loadMoreBtn = document.getElementById('loadMoreBtn');

    var filterTestCaseNo = document.getElementById('filterTestCaseNo');
    var filterTestCaseName = document.getElementById('filterTestCaseName');
    var filterTestCasePath = document.getElementById('filterTestCasePath');
    var filterPriority = document.getElementById('filterPriority');
    var filterTestType = document.getElementById('filterTestType');
    var filterType = document.getElementById('filterType');
    var resetBtn = document.getElementById('resetBtn');
    var resultCount = document.getElementById('resultCount');

    var testTaskNo = '';
    var subTestTaskName = '';
    var testPhaseName = '';

    function ellipsisCell(v, maxLen) {
        var s = v || '';
        var display = escapeHtml(s).replace(/\n/g, '<br>');
        return '<span class="case-desc">' + display + '</span>';
    }

    function htmlCell(v) {
        var s = v || '';
        var display = s.replace(/<\/?(?:table|thead|tbody|tfoot|tr|th|td|caption|colgroup|col)[^>]*>/gi, '');
        display = display.replace(/\n/g, '<br>');
        return '<span class="case-desc">' + display + '</span>';
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

    function matchFilter(row, filters) {
        if (filters.testCaseNo && (row.testCaseNo || '').indexOf(filters.testCaseNo) < 0) return false;
        if (filters.testCaseName && (row.testCaseName || '').indexOf(filters.testCaseName) < 0) return false;
        if (filters.testCasePath && (row.testCasePath || '').indexOf(filters.testCasePath) < 0) return false;
        if (filters.testCasePriority && (row.testCasePriority || '') !== filters.testCasePriority) return false;
        if (filters.testType && (row.testType || '') !== filters.testType) return false;
        if (filters.type && (row.type || '') !== filters.type) return false;
        return true;
    }

    function applyFilters() {
        var filters = getFilters();
        var filtered = allData.filter(function (row) { return matchFilter(row, filters); });
        renderTable(filtered);
    }

    function startFreshLoad() {
        allData = [];
        loadingPage = 0;
        hasMore = true;
        isLoading = false;
        loadMore();
    }

    function loadMore() {
        if (isLoading || !hasMore) return;
        isLoading = true;
        loadingPage++;
        showLoading();
        loadMoreBtn.disabled = true;
        loadMoreBtn.querySelector('.txt').textContent = '加载中...';
        HttpClient.query({
            currentPage: loadingPage,
            pageSize: pageSize,
            testTaskNo: testTaskNo,
            subTestTaskName: subTestTaskName,
            testPhaseName: testPhaseName
        });
    }

    filterTestCaseNo.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') applyFilters();
    });
    filterTestCaseName.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') applyFilters();
    });
    filterTestCasePath.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') applyFilters();
    });
    filterPriority.addEventListener('change', applyFilters);
    filterTestType.addEventListener('change', applyFilters);
    filterType.addEventListener('change', applyFilters);
    resetBtn.addEventListener('click', function () {
        filterTestCaseNo.value = '';
        filterTestCaseName.value = '';
        filterTestCasePath.value = '';
        filterPriority.value = '';
        filterTestType.value = '';
        filterType.value = '';
        applyFilters();
    });
    document.getElementById('refreshBtn').addEventListener('click', function () {
        filterTestCaseNo.value = '';
        filterTestCaseName.value = '';
        filterTestCasePath.value = '';
        filterPriority.value = '';
        filterTestType.value = '';
        filterType.value = '';
        resultCount.textContent = '';
        startFreshLoad();
    });

    loadMoreBtn.addEventListener('click', loadMore);

    function resetTableHeight() {
        var sc = document.getElementById('tableWrap');
        var stickyH = document.querySelector('.sticky-header');
        if (!sc || !stickyH) return;
        var h = stickyH.offsetHeight;
        sc.style.maxHeight = 'calc(100vh - ' + h + 'px)';
    }
    window.addEventListener('resize', resetTableHeight);

    window.addEventListener('message', function (event) {
        var msg = event.data;
        switch (msg.command) {
            case 'init':
                if (msg.testTaskNo) {
                    testTaskNo = msg.testTaskNo;
                    infoTaskName.textContent = msg.testTaskNo;
                }
                if (msg.subTestTaskName) {
                    subTestTaskName = msg.subTestTaskName;
                    infoSubTaskName.textContent = msg.subTestTaskName;
                }
                if (msg.testPhaseName) {
                    testPhaseName = msg.testPhaseName;
                    infoPhaseName.textContent = msg.testPhaseName;
                }
                if (testTaskNo && subTestTaskName && testPhaseName) startFreshLoad();
                break;
            case 'showData':
                isLoading = false;
                for (var i = 0; i < msg.data.length; i++) allData.push(msg.data[i]);
                loadMoreBtn.disabled = false;
                loadMoreBtn.querySelector('.txt').textContent = '更多' + pageSize + '个';
                loadMoreBtn.classList.remove('expanded');
                hasMore = true;
                applyFilters();
                renderLoadMore();
                break;
            case 'endOfData':
                isLoading = false;
                hasMore = false;
                loadMoreBtn.disabled = false;
                loadMoreBtn.querySelector('.txt').textContent = '收起';
                loadMoreBtn.classList.add('expanded');
                if (allData.length === 0) {
                    errorEl.classList.add('hidden');
                    loadingEl.classList.add('hidden');
                    tableWrap.innerHTML = '<div class="empty">暂无数据</div>';
                    tableWrap.classList.remove('hidden');
                    loadMoreEl.classList.add('hidden');
                } else {
                    applyFilters();
                    renderLoadMore();
                }
                break;
            case 'showError':
                isLoading = false;
                loadMoreBtn.disabled = false;
                loadMoreBtn.querySelector('.txt').textContent = '更多' + pageSize + '个';
                loadMoreBtn.classList.remove('expanded');
                showError(msg.message);
                break;
        }
    });

    HttpClient.postMessage({ command: 'ready' });
    setTimeout(resetTableHeight, 0);

    function showLoading() {
        errorEl.classList.add('hidden');
        if (allData.length === 0) {
            loadingEl.classList.remove('hidden');
            tableWrap.classList.add('hidden');
            loadMoreEl.classList.add('hidden');
        }
    }

    function showError(msg) {
        errorEl.textContent = msg;
        errorEl.classList.remove('hidden');
        loadingEl.classList.add('hidden');
        tableWrap.classList.add('hidden');
        loadMoreEl.classList.add('hidden');
    }

    function renderTable(data) {
        loadingEl.classList.add('hidden');
        errorEl.classList.add('hidden');

        var filterActive = filterTestCaseNo.value.trim() || filterTestCaseName.value.trim() || filterTestCasePath.value.trim() || filterPriority.value || filterTestType.value || filterType.value;
        if (data.length > 0) {
            resultCount.textContent = filterActive ? data.length + ' / ' + allData.length + ' 条' : '共 ' + allData.length + ' 条';
        } else {
            resultCount.textContent = allData.length > 0 ? '0 / ' + allData.length + ' 条' : '';
        }

        if (!data || data.length === 0) {
            tableWrap.innerHTML = '<div class="empty">暂无数据</div>';
            tableWrap.classList.remove('hidden');
            return;
        }

        var columns = COLUMNS_ORDER.filter(function (col) { return data[0][col] !== undefined; });
        var html = '<table><thead><tr>';
        for (var i = 0; i < columns.length; i++) {
            html += '<th><span>' + escapeHtml(COLUMN_NAMES[columns[i]] || columns[i]) + '</span><div class="resize-handle"></div></th>';
        }
        html += '</tr></thead><tbody>';
        for (var r = 0; r < data.length; r++) {
            html += '<tr>';
            for (var c = 0; c < columns.length; c++) {
                var col = columns[c];
                var val = data[r][col] !== null && data[r][col] !== undefined ? String(data[r][col]) : '';
                var render = COLUMN_RENDER[col];
                var cellContent = render ? render(val, data[r]) : escapeHtml(val);
                var tooltipContent = (col === 'expected' || col === 'testCaseDes') ? val.replace(/\n/g, '<br>') : escapeHtml(val).replace(/\n/g, '<br>');
                html += '<td><div class="cell-trunc" data-tooltip="' + escapeAttr(tooltipContent) + '">' + cellContent + '</div></td>';
            }
            html += '</tr>';
        }
        html += '</tbody></table>';
        tableWrap.innerHTML = html;
        tableWrap.classList.remove('hidden');
        resetTableHeight();
        enableColumnResize();
    }

    function renderLoadMore() {
        loadMoreEl.classList.remove('hidden');
        if (hasMore) {
            loadMoreBtn.classList.remove('hidden');
            loadMoreBtn.querySelector('.txt').textContent = '更多' + pageSize + '个';
            loadMoreBtn.classList.remove('expanded');
            loadMoreBtn.disabled = false;
        } else {
            loadMoreBtn.classList.add('hidden');
        }
    }

    var tooltipEl = document.getElementById('tooltip');
    var tooltipTimer = null;

    tableWrap.addEventListener('mouseover', function (e) {
        var cell = e.target.closest('.cell-trunc');
        clearTimeout(tooltipTimer);
        if (!cell) { tooltipEl.style.display = 'none'; return; }
        var html = cell.getAttribute('data-tooltip');
        if (!html) { tooltipEl.style.display = 'none'; return; }
        tooltipTimer = setTimeout(function () {
            tooltipEl.innerHTML = html;
            tooltipEl.style.display = 'block';
        }, 300);
    });

    tableWrap.addEventListener('mousemove', function (e) {
        if (tooltipEl.style.display === 'none') return;
        var gap = 16;
        var x = e.clientX + gap;
        var y = e.clientY + gap;
        var tw = tooltipEl.offsetWidth;
        var th = tooltipEl.offsetHeight;
        if (x + tw > window.innerWidth - 8) x = e.clientX - tw - gap;
        if (y + th > window.innerHeight - 8) y = e.clientY - th - gap;
        tooltipEl.style.left = Math.max(4, x) + 'px';
        tooltipEl.style.top = Math.max(4, y) + 'px';
    });

    tableWrap.addEventListener('mouseleave', function () {
        clearTimeout(tooltipTimer);
        tooltipEl.style.display = 'none';
    });

    function enableColumnResize() {
        var ths = document.querySelectorAll('#tableWrap th');
        ths.forEach(function (th, idx) {
            var handle = th.querySelector('.resize-handle');
            if (!handle) return;
            handle.addEventListener('mousedown', function (e) {
                e.preventDefault();
                var startX = e.clientX;
                var startWidth = th.offsetWidth;
                function onMouseMove(e) {
                    var diff = e.clientX - startX;
                    var newWidth = Math.max(30, startWidth + diff);
                    var cells = document.querySelectorAll('#tableWrap table tr > *:nth-child(' + (idx + 1) + ')');
                    cells.forEach(function (cell) {
                        cell.style.width = newWidth + 'px';
                        cell.style.minWidth = newWidth + 'px';
                        cell.style.maxWidth = newWidth + 'px';
                    });
                }
                function onMouseUp() {
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                }
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
            });
        });
    }

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
