// ============ 测试案例页面 ============
import { Table, Loading, Tooltip, debounce } from '../common/index.js';

const vscode = acquireVsCodeApi();

(function () {
    // ============ 组件初始化 ============
    const table = new Table('#tableWrap', { selectable: false, resizable: true });
    const loading = new Loading('#loading');
    const tooltip = new Tooltip('tooltip');
    tooltip.enableForTable(document.getElementById('tableWrap'));

    // ============ 页面元素引用 ============
    const $ = (id) => document.getElementById(id);
    const infoTaskName = $('infoTaskName');
    const infoSubTaskName = $('infoSubTaskName');
    const infoPhaseName = $('infoPhaseName');
    const errorEl = $('error');
    const loadMoreEl = $('loadMore');
    const loadMoreBtn = $('loadMoreBtn');
    const resultCount = $('resultCount');

    const filterTestCaseNo = $('filterTestCaseNo');
    const filterTestCaseName = $('filterTestCaseName');
    const filterTestCasePath = $('filterTestCasePath');
    const filterPriority = $('filterPriority');
    const filterTestType = $('filterTestType');
    const filterType = $('filterType');
    const resetBtn = $('resetBtn');
    const refreshBtn = $('refreshBtn');

    // ============ 状态 ============
    let testTaskNo = '';
    let subTestTaskName = '';
    let testPhaseName = '';
    let allData = [];
    let hasMore = true;
    let isLoading = false;
    const PAGE_SIZE = 15;

    // ============ 工具函数 ============
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

    function hasActiveFilter() {
        const f = getFilters();
        return f.testCaseNo || f.testCaseName || f.testCasePath || f.testCasePriority || f.testType || f.type;
    }

    function matchFilter(row, f) {
        if (f.testCaseNo && (row.testCaseNo || '').indexOf(f.testCaseNo) < 0) return false;
        if (f.testCaseName && (row.testCaseName || '').indexOf(f.testCaseName) < 0) return false;
        if (f.testCasePath && (row.testCasePath || '').indexOf(f.testCasePath) < 0) return false;
        if (f.testCasePriority && (row.testCasePriority || '') !== f.testCasePriority) return false;
        if (f.testType && (row.testType || '') !== f.testType) return false;
        if (f.type && (row.type || '') !== f.type) return false;
        return true;
    }

    function applyFilters() {
        const f = getFilters();
        const filtered = allData.filter(row => matchFilter(row, f));
        const headers = filtered.length > 0 ? Object.keys(filtered[0]) : (allData.length > 0 ? Object.keys(allData[0]) : []);
        const rows = filtered.map(row => headers.map(h => row[h]));

        if (filtered.length === 0) {
            table.showEmpty(allData.length === 0 ? '暂无数据' : '没有匹配的数据');
        } else {
            table.render({ headers, rows });
        }
        updateResultCount(filtered);
    }

    function updateResultCount(filtered) {
        if (allData.length === 0) {
            resultCount.textContent = '';
        } else if (hasActiveFilter()) {
            resultCount.textContent = `${filtered.length} / ${allData.length} 条`;
        } else {
            resultCount.textContent = `共 ${allData.length} 条`;
        }
    }

    function resetTableHeight() {
        const sc = document.getElementById('tableWrap');
        const stickyH = document.querySelector('.sticky-header');
        if (!sc || !stickyH) return;
        sc.style.maxHeight = `calc(100vh - ${stickyH.offsetHeight}px)`;
    }

    function showError(message) {
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
    }

    function clearError() {
        errorEl.classList.add('hidden');
    }

    // ============ 加载逻辑 ============
    function startFreshLoad() {
        allData = [];
        hasMore = true;
        isLoading = false;
        clearError();
        loadMore();
    }

    function loadMore() {
        if (isLoading || !hasMore) return;
        isLoading = true;
        loading.show('加载测试案例...');
        loadMoreBtn.disabled = true;
        loadMoreBtn.querySelector('.txt').textContent = '加载中...';

        vscode.postMessage({
            command: 'query',
            currentPage: Math.floor(allData.length / PAGE_SIZE) + 1,
            pageSize: PAGE_SIZE,
            testTaskNo,
            subTestTaskName,
            testPhaseName
        });
    }

    function renderLoadMore() {
        loadMoreEl.classList.remove('hidden');
        if (hasMore) {
            loadMoreBtn.classList.remove('hidden', 'expanded');
            loadMoreBtn.querySelector('.txt').textContent = `更多${PAGE_SIZE}个`;
            loadMoreBtn.disabled = false;
        } else {
            loadMoreBtn.classList.add('hidden');
        }
    }

    function clearAllFilters() {
        filterTestCaseNo.value = '';
        filterTestCaseName.value = '';
        filterTestCasePath.value = '';
        filterPriority.value = '';
        filterTestType.value = '';
        filterType.value = '';
    }

    // ============ 事件绑定 ============
    filterTestCaseNo.addEventListener('input', debounce(applyFilters, 300));
    filterTestCaseName.addEventListener('input', debounce(applyFilters, 300));
    filterTestCasePath.addEventListener('input', debounce(applyFilters, 300));
    filterPriority.addEventListener('change', applyFilters);
    filterTestType.addEventListener('change', applyFilters);
    filterType.addEventListener('change', applyFilters);

    resetBtn.addEventListener('click', () => {
        clearAllFilters();
        applyFilters();
    });

    refreshBtn.addEventListener('click', () => {
        clearAllFilters();
        resultCount.textContent = '';
        startFreshLoad();
    });

    loadMoreBtn.addEventListener('click', loadMore);
    window.addEventListener('resize', resetTableHeight);

    // ============ 消息处理 ============
    window.addEventListener('message', function (event) {
        const msg = event.data;
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
                allData.push(...(msg.data || []));
                hasMore = true;
                applyFilters();
                renderLoadMore();
                loading.hide();
                break;

            case 'endOfData':
                isLoading = false;
                hasMore = false;
                if (allData.length === 0) {
                    table.showEmpty('暂无数据');
                    loadMoreEl.classList.add('hidden');
                } else {
                    applyFilters();
                    renderLoadMore();
                    loadMoreBtn.classList.remove('hidden');
                    loadMoreBtn.querySelector('.txt').textContent = '收起';
                    loadMoreBtn.classList.add('expanded');
                    loadMoreBtn.disabled = false;
                }
                loading.hide();
                break;

            case 'showError':
                isLoading = false;
                loadMoreBtn.disabled = false;
                loadMoreBtn.querySelector('.txt').textContent = `更多${PAGE_SIZE}个`;
                loadMoreBtn.classList.remove('expanded');
                loading.hide();
                showError(msg.message || '加载失败');
                break;
        }
    });

    // ============ 启动 ============
    vscode.postMessage({ command: 'ready' });
    setTimeout(resetTableHeight, 0);
    console.log('[TestCase] 页面已加载');
})();