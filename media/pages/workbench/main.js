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

    var SUBTASK_COUNT_MAP = {
        "T-2026-0112": 4, "T-2026-0115": 3, "T-2026-0108": 3, "T-2026-0113": 2,
        "T-2026-0117": 2, "T-2026-0098": 2, "T-2026-0120": 0, "T-2026-0121": 2,
        "T-2026-0122": 2, "T-2026-0099": 2, "T-2026-0100": 2, "T-2026-0123": 2,
        "T-2026-0124": 1, "T-2026-0125": 2, "T-2026-0126": 2, "T-2026-0127": 2,
        "T-2026-0101": 2, "T-2026-0128": 2, "T-2026-0130": 1, "T-2026-0131": 2
    };

    var TASKS = [
        { id: 'T-2026-0112', code: 'T-2026-0112', name: '支付中心重构测试', statusClass: 'status-exec', statusText: '执行中', subtaskCount: 4 },
        { id: 'T-2026-0115', code: 'T-2026-0115', name: '会员体系H5完整回归', statusClass: 'status-exec', statusText: '执行中', subtaskCount: 3 },
        { id: 'T-2026-0108', code: 'T-2026-0108', name: '商品搜索算法优化', statusClass: 'status-review', statusText: '评审中', subtaskCount: 3 },
        { id: 'T-2026-0113', code: 'T-2026-0113', name: '订单履约系统性能测试(已延期)', statusClass: 'status-delay', statusText: '已延期', subtaskCount: 2 },
        { id: 'T-2026-0117', code: 'T-2026-0117', name: '消息推送服务国际化改造', statusClass: 'status-design', statusText: '设计中', subtaskCount: 2 },
        { id: 'T-2026-0098', code: 'T-2026-0098', name: '用户登录安全增强验收', statusClass: 'status-done', statusText: '已完成', subtaskCount: 2 },
        { id: 'T-2026-0120', code: 'T-2026-0120', name: '图片上传CDN迁移验证', statusClass: 'status-pending', statusText: '待启动', subtaskCount: 0 },
        { id: 'T-2026-0121', code: 'T-2026-0121', name: 'IM即时通讯功能回归', statusClass: 'status-exec', statusText: '执行中', subtaskCount: 2 },
        { id: 'T-2026-0122', code: 'T-2026-0122', name: '数据看板大屏兼容测试', statusClass: 'status-design', statusText: '设计中', subtaskCount: 2 },
        { id: 'T-2026-0099', code: 'T-2026-0099', name: '优惠券系统重构回归', statusClass: 'status-exec', statusText: '执行中', subtaskCount: 2 },
        { id: 'T-2026-0100', code: 'T-2026-0100', name: '消息通知中心改造', statusClass: 'status-done', statusText: '已完成', subtaskCount: 2 },
        { id: 'T-2026-0123', code: 'T-2026-0123', name: 'WebSocket推送稳定性测试', statusClass: 'status-paused', statusText: '已暂停', subtaskCount: 2 },
        { id: 'T-2026-0124', code: 'T-2026-0124', name: '小程序分享卡片改版', statusClass: 'status-pending', statusText: '待启动', subtaskCount: 1 },
        { id: 'T-2026-0125', code: 'T-2026-0125', name: '多语言翻译平台集成测试', statusClass: 'status-exec', statusText: '执行中', subtaskCount: 2 },
        { id: 'T-2026-0126', code: 'T-2026-0126', name: '直播间礼物特效回归', statusClass: 'status-paused', statusText: '已暂停', subtaskCount: 2 },
        { id: 'T-2026-0127', code: 'T-2026-0127', name: '三方登录联合调试', statusClass: 'status-design', statusText: '设计中', subtaskCount: 2 },
        { id: 'T-2026-0101', code: 'T-2026-0101', name: '搜索防抖与联想缓存', statusClass: 'status-review', statusText: '评审中', subtaskCount: 2 },
        { id: 'T-2026-0128', code: 'T-2026-0128', name: 'OCR识别服务压力测试', statusClass: 'status-done', statusText: '已完成', subtaskCount: 2 },
        { id: 'T-2026-0130', code: 'T-2026-0130', name: 'App启动性能基线评测(已延期)', statusClass: 'status-delay', statusText: '已延期', subtaskCount: 1 },
        { id: 'T-2026-0131', code: 'T-2026-0131', name: '推送通知栏适配测试', statusClass: 'status-exec', statusText: '执行中', subtaskCount: 2 }
    ];

    var _currentId = localStorage.getItem('wb_currentTaskId') || 'T-2026-0112';

    function getAll() { return TASKS; }
    function getCurrentId() { return _currentId; }
    function setCurrentId(id) {
        _currentId = id;
        localStorage.setItem('wb_currentTaskId', id);
        syncCardsCurrent();
        var switcher = document.querySelector('.ts-current-name');
        if (switcher) {
            var task = TASKS.find(function (t) { return t.id === id; });
            if (task) {
                switcher.textContent = task.name;
                var tag = document.querySelector('.ts-current-tag');
                if (tag) { tag.textContent = task.statusText; tag.className = 'ts-current-tag ' + task.statusClass; }
            }
        }
    }

    function syncCardsCurrent() {
        document.querySelectorAll('.task-card').forEach(function (c) {
            c.classList.toggle('current', c.getAttribute('data-task-id') === _currentId);
        });
    }

    function renderTaskCards() {
        var grid = document.getElementById('myTaskGrid');
        if (!grid) return;
        grid.innerHTML = TASKS.map(function (t) {
            var subCount = SUBTASK_COUNT_MAP[t.id] != null ? SUBTASK_COUNT_MAP[t.id] : 0;
            var safeName = (t.name || '').replace(/"/g, '&quot;');
            return '<div class="task-card' + (t.id === _currentId ? ' current' : '') + '"' +
                ' data-task-id="' + t.id + '"' +
                ' data-task-name="' + safeName + '"' +
                ' data-task-status="' + (t.statusText || '') + '"' +
                ' data-status-class="' + (t.statusClass || 'status-exec') + '">' +
                '<span class="tc-current-badge">\u25CF 当前任务</span>' +
                (t.id !== _currentId ? '<span class="tc-switch-hint">点击切换为当前任务</span>' : '') +
                '<div class="tc-title" title="' + safeName + '">' + (t.name || '') + '</div>' +
                '<div class="tc-subcount">共 ' + subCount + ' 个子任务</div>' +
                '</div>';
        }).join('');
    }

    document.addEventListener('DOMContentLoaded', function () {
        renderTaskCards();
        updateCounts();
        applyView();
        var curTask = TASKS.find(function (t) { return t.id === _currentId; });
        var switcher = document.querySelector('.ts-current-name');
        var tag = document.querySelector('.ts-current-tag');
        if (curTask && switcher && tag) {
            switcher.textContent = curTask.name;
            tag.textContent = curTask.statusText;
            tag.className = 'ts-current-tag ' + curTask.statusClass;
        }
        document.getElementById('myTaskGrid').addEventListener('click', function (e) {
            var card = e.target.closest('.task-card');
            if (!card) return;
            var id = card.getAttribute('data-task-id');
            if (!id) return;
            setCurrentId(id);
            HttpClient.postMessage({ command: 'openTestTask', taskId: id, taskName: card.getAttribute('data-task-name') });
        });
    });

    function updateCounts() {
        var cards = document.querySelectorAll('#myTaskGrid .task-card');
        var total = 0;
        var buckets = { 'status-pending': 0, 'status-design': 0, 'status-exec': 0, 'status-review': 0, 'status-paused': 0, 'status-delay': 0 };
        cards.forEach(function (c) {
            var s = c.getAttribute('data-status-class');
            if (s !== 'status-done') total++;
            if (buckets.hasOwnProperty(s)) buckets[s]++;
        });
        var filter = document.getElementById('myTaskFilter');
        if (filter) {
            filter.querySelectorAll('[data-count]').forEach(function (n) {
                var key = n.getAttribute('data-count');
                n.textContent = key === 'all' ? total : (buckets[key] || 0);
            });
        }
        var countTip = document.getElementById('myTaskCount');
        if (countTip) countTip.textContent = '共 ' + total + ' 个未完成';

        var done = 0;
        cards.forEach(function (c) {
            if (c.getAttribute('data-status-class') === 'status-done') done++;
        });
        var statEls = {
            taskInProgress: total,
            subtaskTotal: (function () {
                var s = 0;
                cards.forEach(function (c) {
                    if (c.getAttribute('data-status-class') !== 'status-done') {
                        var m = /(\d+)/.exec((c.querySelector('.tc-subcount') || {}).textContent || '');
                        if (m) s += parseInt(m[1], 10);
                    }
                });
                return s;
            })(),
            taskDone: done
        };
        Object.keys(statEls).forEach(function (k) {
            document.querySelectorAll('[data-stat="' + k + '"]').forEach(function (el) { el.textContent = statEls[k]; });
        });
    }

    var INITIAL_LIMIT = 6, LOAD_STEP = 3;
    var visibleNow = INITIAL_LIMIT, currentFilter = 'all';

    function applyView() {
        var grid = document.getElementById('myTaskGrid');
        if (!grid) return;
        var allCards = Array.prototype.slice.call(grid.querySelectorAll('.task-card'));
        var cards = allCards.filter(function (c) { return c.getAttribute('data-status-class') !== 'status-done'; });
        var matched = cards.filter(function (c) {
            if (currentFilter === 'all') return true;
            return c.getAttribute('data-status-class') === currentFilter;
        });
        allCards.forEach(function (c) { c.style.display = 'none'; c.classList.remove('hidden-more'); });
        var count = Math.min(visibleNow, matched.length);
        matched.forEach(function (c, i) {
            c.style.display = i < count ? '' : 'none';
            if (i >= count) c.classList.add('hidden-more');
        });
        var moreBar = document.getElementById('myTaskMoreBar');
        var moreBtn = document.getElementById('myTaskMoreBtn');
        if (moreBar && moreBtn) {
            var hasMore = matched.length > visibleNow;
            var canCollapse = !hasMore && visibleNow > INITIAL_LIMIT;
            moreBar.style.display = hasMore || canCollapse ? 'flex' : 'none';
            if (hasMore) {
                var nextStep = Math.min(LOAD_STEP, matched.length - visibleNow);
                moreBtn.querySelector('.txt').textContent = '更多 ' + nextStep + ' 个';
                moreBtn.classList.remove('expanded');
            } else {
                moreBtn.querySelector('.txt').textContent = '收起';
                moreBtn.classList.add('expanded');
            }
        }
    }

    document.addEventListener('DOMContentLoaded', function () {
        var filter = document.getElementById('myTaskFilter');
        if (filter) {
            filter.addEventListener('click', function (e) {
                var item = e.target.closest('.task-filter-item');
                if (!item) return;
                filter.querySelectorAll('.task-filter-item').forEach(function (el) { el.classList.remove('active'); });
                item.classList.add('active');
                currentFilter = item.getAttribute('data-filter') || 'all';
                visibleNow = INITIAL_LIMIT;
                applyView();
            });
        }
        var moreBtn = document.getElementById('myTaskMoreBtn');
        if (moreBtn) {
            moreBtn.addEventListener('click', function () {
                var cards = Array.prototype.slice.call(document.querySelectorAll('#myTaskGrid .task-card'));
                var matched = cards.filter(function (c) {
                    if (c.getAttribute('data-status-class') === 'status-done') return false;
                    if (currentFilter === 'all') return true;
                    return c.getAttribute('data-status-class') === currentFilter;
                });
                if (visibleNow >= matched.length) {
                    visibleNow = INITIAL_LIMIT;
                } else {
                    visibleNow = Math.min(visibleNow + LOAD_STEP, matched.length);
                }
                applyView();
            });
        }
        var statRow = document.getElementById('statRow');
        if (statRow) {
            statRow.addEventListener('click', function (e) {
                var card = e.target.closest('.stat-card');
                if (!card) return;
                var action = card.getAttribute('data-action');
                if (action === 'task') {
                    var allTab = document.querySelector('#myTaskFilter .task-filter-item[data-filter="all"]');
                    if (allTab && !allTab.classList.contains('active')) allTab.click();
                    var grid = document.getElementById('myTaskGrid');
                    if (grid) grid.scrollIntoView({ behavior: 'smooth', block: 'center' });
                } else if (action === 'todo') {
                    var todoList = document.getElementById('todoList');
                    if (todoList) todoList.scrollIntoView({ behavior: 'smooth', block: 'center' });
                } else if (action === 'done') {
                    HttpClient.postMessage({ command: 'openTestTask' });
                }
            });
        }
        var sideMenu = document.querySelector('.side-menu');
        if (sideMenu) {
            sideMenu.addEventListener('click', function (e) {
                var item = e.target.closest('.menu-item');
                if (!item) return;
                var action = item.getAttribute('data-action');
                if (action) HttpClient.postMessage({ command: action });
            });
        }
    });

    window.TMSGlobal = { getAll: getAll, getCurrentId: getCurrentId, setCurrent: setCurrentId };
})();
