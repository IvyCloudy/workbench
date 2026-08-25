const http = require('http');

const TOTAL = 5000;
const PHASES = ['ST阶段', 'UAT阶段', '合并测试阶段'];
const TYPES = ['流程类', '功能点类', '界面类', '安全类', '批处理类', '报文接口类', '可用性检查类', '数据仓库类', '算法类', '报表统计类', '其他'];
const TEST_TYPES = ['手工', '自动化', '半自动化'];
const SOURCES = ['TMS', 'AITEST', 'RFWeb', 'ARD', 'CMBT_MANUAL', 'APIAUTO'];
const TESTERS = ['张三/123454', '李四/123457', '王五/123460', '赵六/123463'];
const PRIORITIES = ['高', '高', '中', '中', '低'];

function generateRecord(i, testTaskNo, subTestTaskName) {
    var phase = PHASES[i % PHASES.length];
    var type = TYPES[i % TYPES.length];
    var testType = TEST_TYPES[i % TEST_TYPES.length];
    var source = SOURCES[i % SOURCES.length];
    var tester = TESTERS[i % TESTERS.length];
    var num = String(i + 1).padStart(4, '0');

    return {
        testCaseId: i + 1,
        testCasePriority: PRIORITIES[i % PRIORITIES.length],
        testTaskNo: testTaskNo,
        testTaskName: testTaskNo + '验证',
        subTestTaskName: subTestTaskName,
        testPhaseName: phase,
        roundName: '第' + ((i % 5) + 1) + '轮',
        testCaseNo: 'TC_' + num,
        testCaseName: '测试场景' + num,
        testProduct: null,
        testCasePath: '阶段' + ((i % 3) + 1) + '/test' + testTaskNo + '/',
        preCondition: '前置条件_' + num,
        description: '步骤1:操作' + (i + 1) + ';步骤2:验证;',
        expected: '期望结果_' + num + '：系统应返回正确结果，\n状态码为200，响应时间不超过2秒，数据完整写入数据库，日志记录完整，异常情况下有明确错误提示，操作前后数据一致性校验通过，涉及关联系统的接口调用均返回成功',
        testCaseCheckPoint: (i % 10) + '.0',
        source: source,
        testType: testType,
        type: type,
        testCaseDes: '验证' + type + '场景' + num + '，测试任务' + testTaskNo + '的子任务' + subTestTaskName + '，执行阶段为\n' + phase + '，优先级为' + PRIORITIES[i % PRIORITIES.length] + '，采用' + testType + '方式执行，验证功能正确性、数据完整性和系统稳定性，覆盖正常流程和异常分支，确保业务逻辑符合需求规格说明书的要求',
        cmbtId: '',
        designer: tester
    };
}

var TASK_TREE = [
    {
        testTaskId: 1, testTaskNo: 'TT2025123500', testTaskName: '2026数据测试', aplusFlag: '否',
        subTestTaskList: [
            { subTestTaskId: 110, subTestTaskName: '测试子任务1', gchFlag: '否', gchClassify: '', accTestFlag: '是', aiFlag: '否', miniFlag: '否', urgentFlag: '否', testPhaseList: [
                { testPhaseName: '合并测试阶段', leader: '张三/IT00001', status: '未启动', testPhaseId: 213, accTestFlag: '否' },
                { testPhaseName: 'ST阶段', leader: '李四/IT00007', status: '实施中', testPhaseId: 214, accTestFlag: '否' }
            ]},
            { subTestTaskId: 111, subTestTaskName: '测试子任务2', gchFlag: '否', gchClassify: '', accTestFlag: '否', aiFlag: '是', miniFlag: '否', urgentFlag: '否', testPhaseList: [
                { testPhaseName: 'UAT阶段', leader: '王五/IT00012', status: '已完成', testPhaseId: 215, accTestFlag: '是' },
                { testPhaseName: '合并测试阶段', leader: '赵六/IT00018', status: '未启动', testPhaseId: 216, accTestFlag: '否' }
            ]}
        ]
    },
    {
        testTaskId: 2, testTaskNo: 'TT2025123701', testTaskName: '2026测试平台', aplusFlag: '否',
        subTestTaskList: [
            { subTestTaskId: 220, subTestTaskName: '测试子任务3', gchFlag: '否', gchClassify: '', accTestFlag: '否', aiFlag: '否', miniFlag: '否', urgentFlag: '否', testPhaseList: [
                { testPhaseName: '合并测试阶段', leader: '李四/IT00007', status: '实施中', testPhaseId: 45456, accTestFlag: '否' },
                { testPhaseName: 'ST阶段', leader: '张三/IT00001', status: '未启动', testPhaseId: 45457, accTestFlag: '否' }
            ]},
            { subTestTaskId: 221, subTestTaskName: '测试子任务4', gchFlag: '否', gchClassify: '', accTestFlag: '是', aiFlag: '否', miniFlag: '是', urgentFlag: '否', testPhaseList: [
                { testPhaseName: 'UAT阶段', leader: '王五/IT00012', status: '已完成', testPhaseId: 45458, accTestFlag: '是' }
            ]}
        ]
    },
    {
        testTaskId: 3, testTaskNo: 'TT2026123401', testTaskName: '核心交易系统回归', aplusFlag: '否',
        subTestTaskList: [
            { subTestTaskId: 330, subTestTaskName: '测试子任务5', gchFlag: '是', gchClassify: '回归', accTestFlag: '否', aiFlag: '否', miniFlag: '否', urgentFlag: '是', testPhaseList: [
                { testPhaseName: '合并测试阶段', leader: '赵六/IT00018', status: '未启动', testPhaseId: 33001, accTestFlag: '否' },
                { testPhaseName: 'ST阶段', leader: '李四/IT00007', status: '实施中', testPhaseId: 33002, accTestFlag: '否' },
                { testPhaseName: 'UAT阶段', leader: '张三/IT00001', status: '未启动', testPhaseId: 33003, accTestFlag: '是' }
            ]},
            { subTestTaskId: 331, subTestTaskName: '测试子任务6', gchFlag: '否', gchClassify: '', accTestFlag: '否', aiFlag: '否', miniFlag: '否', urgentFlag: '否', testPhaseList: [
                { testPhaseName: 'UAT阶段', leader: '王五/IT00012', status: '已完成', testPhaseId: 33101, accTestFlag: '是' }
            ]}
        ]
    },
    {
        testTaskId: 4, testTaskNo: 'TT2026010101', testTaskName: '风控模型升级', aplusFlag: '是',
        subTestTaskList: [
            { subTestTaskId: 440, subTestTaskName: '测试子任务7', gchFlag: '否', gchClassify: '', accTestFlag: '否', aiFlag: '是', miniFlag: '否', urgentFlag: '否', testPhaseList: [
                { testPhaseName: '合并测试阶段', leader: '张三/IT00001', status: '实施中', testPhaseId: 44001, accTestFlag: '否' }
            ]}
        ]
    }
];

var server = http.createServer(function (req, res) {
    if (req.method === 'POST' && req.url === '/test-task/task-tree') {
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end(JSON.stringify({ errorMsg: '', body: TASK_TREE, returnCode: 'SUC0000' }));
    } else if (req.method === 'POST' && req.url === '/test-task/test-case') {
        var body = '';
        req.on('data', function (chunk) { body += chunk; });
        req.on('end', function () {
            var params = JSON.parse(body);
            var testTaskNo = params.testTaskNo || 'TASK001';
            var subTestTaskName = params.subTestTaskName || '测试1';
            var pageSize = parseInt(params.pageSize, 10) || 200;
            var currentPage = params.currentPage || 1;

            var filterTestCaseNo = (params.testCaseNo || '').trim();
            var filterTestCaseName = (params.testCaseName || '').trim();
            var filterTestCasePath = (params.testCasePath || '').trim();
            var filterPriority = (params.testCasePriority || '').trim();
            var filterTestType = (params.testType || '').trim();
            var filterType = (params.type || '').trim();
            var filterPhase = (params.testPhaseName || '').trim();
            var filterRound = (params.roundName || '').trim();
            var filterSource = (params.source || '').trim();

            console.log('收到请求:', JSON.stringify(params));

            var allData = [];
            for (var i = 0; i < TOTAL; i++) {
                var rec = generateRecord(i, testTaskNo, subTestTaskName);
                if (filterTestCaseNo && rec.testCaseNo.indexOf(filterTestCaseNo) < 0) continue;
                if (filterTestCaseName && rec.testCaseName.indexOf(filterTestCaseName) < 0) continue;
                if (filterTestCasePath && rec.testCasePath.indexOf(filterTestCasePath) < 0) continue;
                if (filterPriority && rec.testCasePriority !== filterPriority) continue;
                if (filterTestType && rec.testType !== filterTestType) continue;
                if (filterType && rec.type !== filterType) continue;
                if (filterPhase && rec.testPhaseName !== filterPhase) continue;
                if (filterRound && rec.roundName.indexOf(filterRound) < 0) continue;
                if (filterSource && rec.source !== filterSource) continue;
                allData.push(rec);
            }

            var totalFiltered = allData.length;
            var start = (currentPage - 1) * pageSize;
            var end = Math.min(start + pageSize, totalFiltered);
            var pageData = allData.slice(start, end);

            var isEnd = pageData.length === 0 && totalFiltered > 0;
            var isEmpty = pageData.length === 0 && totalFiltered === 0;

            res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });

            if (isEmpty) {
                res.end(JSON.stringify({
                    errorMsg: '任务测试案例信息不存在',
                    body: [],
                    returnCode: '2005',
                    total: 0,
                    currentPage: currentPage,
                    pageSize: String(pageSize)
                }));
            } else if (isEnd) {
                res.end(JSON.stringify({
                    errorMsg: '任务测试案例信息不存在',
                    body: [],
                    returnCode: '2005',
                    total: totalFiltered,
                    currentPage: currentPage,
                    pageSize: String(pageSize)
                }));
            } else {
                res.end(JSON.stringify({
                    errorMsg: '',
                    body: pageData,
                    returnCode: 'SUC0000',
                    total: totalFiltered,
                    currentPage: currentPage,
                    pageSize: String(pageSize)
                }));
            }
        });
    } else if (req.method === 'POST' && req.url === '/test-task/push-testcase') {
        var body = '';
        req.on('data', function (chunk) { body += chunk; });
        req.on('end', function () {
            var payload = {};
            try { payload = JSON.parse(body); } catch (e) { payload = {}; }

            // 兼容三种格式：
            //   1) { testTaskNo, subTestTaskId, artifactId, caseList: [...] } ← 当前线上契约
            //   2) { testTaskNo, subTestTaskName, data: [...] }              ← 历史格式
            //   3) [...]                                                    ← 旧格式（向后兼容）
            var testTaskNo = '';
            var subTestTaskName = '';
            var subTestTaskId = '';
            var artifactId = '';
            var data = [];
            if (Array.isArray(payload)) {
                data = payload;
            } else if (payload && typeof payload === 'object') {
                testTaskNo = payload.testTaskNo || '';
                subTestTaskName = payload.subTestTaskName || '';
                subTestTaskId = payload.subTestTaskId || '';
                artifactId = payload.artifactId || '';
                if (Array.isArray(payload.caseList)) {
                    data = payload.caseList;
                } else if (Array.isArray(payload.data)) {
                    data = payload.data;
                }
            }

            console.log('收到推送测试案例请求 testTaskNo=%s subTestTaskId=%s subTestTaskName=%s artifactId=%s 共 %d 条',
                testTaskNo || '(未提供)', subTestTaskId || '(未提供)', subTestTaskName || '(未提供)', artifactId || '(未提供)', data.length);
            if (data.length > 0) {
                console.log('数据示例:', JSON.stringify(data[0], null, 2));
            }

            // 数据为空时生成 3 条模拟结果，方便前端联调
            if (!data || data.length === 0) {
                var now = Date.now();
                data = [
                    { sourceId: 'CASE_001', testCaseName: '模拟案例-正常登录' },
                    { sourceId: 'CASE_002', testCaseName: '模拟案例-密码错误' },
                    { sourceId: 'CASE_003', testCaseName: '模拟案例-账号锁定' }
                ];
                console.log('  请求 data 为空，使用模拟数据 | 共 %d 条', data.length);
            }

            // 按 tsId 逐条返回处理结果。
            // 调试约定：
            //   - type:'1' = 成功，type:'2' = 失败
            //   - 失败比例通过 FAIL_RATIO 控制（0~1，默认 0 即全部成功）
            //   - 临时调试可设为 1.0（全部失败）或 0.5（一半失败）
            var FAIL_RATIO = 0;
            var failCount = 0;
            var resultBody = data.map(function (rec, i) {
                // 当前契约：caseList 项中已有 sourceId（值即客户端的 testcase_id）；
                // 兼容历史 data 数组直接传 testcase_id 的情况
                var tsId = '';
                if (rec) {
                    if (rec.sourceId != null && String(rec.sourceId) !== '') tsId = String(rec.sourceId);
                    else if (rec.testcase_id != null) tsId = String(rec.testcase_id);
                }
                // FAIL_RATIO<=0 时短路，保证 0 比例即全部成功；避免 1/0=Infinity 导致的除零陷阱
                var shouldFail = FAIL_RATIO > 0 && (
                    data.length === 1
                        ? true                                         // 单条时：FAIL_RATIO>0 即失败
                        : (i % Math.round(1 / FAIL_RATIO) !== 0)       // 多条时：按比例失败
                );
                if (!shouldFail) {
                    return {
                        data: 'TT' + Date.now() + (1000 + i),
                        sourceId: tsId,
                        type: '1'
                    };
                }
                failCount++;
                return {
                    data: '无效的案例类型',
                    sourceId: tsId,
                    type: '2'
                };
            });
            if (failCount > 0) {
                console.log('  模拟失败: %d / %d 条 (FAIL_RATIO=%s)', failCount, data.length, FAIL_RATIO);
            }

            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            });
            var responseBody = {
                returnCode: 'SUC0000',
                errorMsg: '',
                body: resultBody
            };
            res.end(JSON.stringify(responseBody));
        });
    } else if (req.method === 'POST' && req.url === '/test-task/delete-testcase') {
        var body = '';
        req.on('data', function (chunk) { body += chunk; });
        req.on('end', function () {
            var payload = {};
            try { payload = JSON.parse(body); } catch (e) { payload = {}; }

            var testTaskNo = payload.testTaskNo || '';
            var subTestTaskId = payload.subTestTaskId || '';
            var sourceIds = Array.isArray(payload.sourceIds) ? payload.sourceIds : [];

            var _ts = new Date().toISOString();
            console.log('[%s] 收到删除测试案例请求 testTaskNo=%s subTestTaskId=%s 共 %d 条 sourceIds=%s',
                _ts, testTaskNo || '(未提供)', subTestTaskId || '(未提供)', sourceIds.length, JSON.stringify(sourceIds));
            console.log('  UA=%s remote=%s:%s', req.headers['user-agent'] || '(无)', req.socket.remoteAddress, req.socket.remotePort);

            // 逐条返回删除结果：type:'1' 成功，type:'2' 失败
            var FAIL_RATIO = 0.5;
            var failCount = 0;
            var resultBody = sourceIds.map(function (id, i) {
                var shouldFail = FAIL_RATIO > 0 && (
                    sourceIds.length === 1
                        ? true
                        : (i % Math.round(1 / FAIL_RATIO) !== 0)
                );
                if (!shouldFail) {
                    return {
                        data: 'TT' + Date.now() + (1000 + i),
                        sourceId: String(id),
                        type: '1'
                    };
                }
                failCount++;
                return {
                    data: '无效的案例类型',
                    sourceId: String(id),
                    type: '2'
                };
            });
            if (failCount > 0) {
                console.log('  模拟失败: %d / %d 条 (FAIL_RATIO=%s)', failCount, sourceIds.length, FAIL_RATIO);
            }

            var responseBody = {
                returnCode: 'SUC0000',
                errorMsg: '',
                body: resultBody
            };
            var _respStr = JSON.stringify(responseBody);
            var _respBuf = Buffer.from(_respStr, 'utf8');
            // 显式带 Content-Length，避免 Node http 自动切换到 chunked 编码
            // （VSCode 扩展宿主对 chunked 响应存在丢 body 的问题）
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': _respBuf.length,
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            });
            console.log('  ↩ 返回字节流(%d bytes): %s', _respBuf.length, _respStr);
            res.end(_respBuf);
        });
    } else if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(8081, function () {
    console.log('Mock server running at http://localhost:8081');
    console.log('Endpoints:');
    console.log('  POST /test-task/task-tree       - 任务树');
    console.log('  POST /test-task/test-case       - 测试案例');
    console.log('  POST /test-task/push-testcase   - 推送测试案例');
    console.log('  POST /test-task/delete-testcase - 删除测试案例');
    console.log('Total records: ' + TOTAL + ', default pageSize: 200');
});
