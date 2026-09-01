const http = require('http');

const TOTAL = 5000;
const PHASES = ['ST阶段', 'UAT阶段', '合并测试阶段'];
const TYPES = ['流程类', '功能点类', '界面类', '安全类', '批处理类', '报文接口类', '可用性检查类', '数据仓库类', '算法类', '报表统计类', '其他'];
const TEST_TYPES = ['手工', '自动化', '半自动化'];
const SOURCES = ['TMS', 'AITEST', 'RFWeb', 'ARD', 'CMBT_MANUAL', 'APIAUTO'];
const TESTERS = ['张三/123454', '李四/123457', '王五/123460', '赵六/123463'];
const PRIORITIES = ['高', '高', '中', '中', '低'];

// ============================================================================
// 删除确认接口的 type 分布比例（mock 专用）
//   CONFIRM_RATIO：需要确认后删除（type=2，存在执行/缺陷关联）的条数占比
//   MISSING_RATIO：案例不存在（type=3）的条数占比
//   其余为 type=1（允许直接删除）
// 可用环境变量覆盖后重启生效，例如：
//   MOCK_CONFIRM_RATIO=0.5 MOCK_MISSING_RATIO=0.2 node mock-server.js
// 说明：比例只作用于「未带调试前缀」的 sourceId；
//       CONFIRM_ / MISSING_ 前缀始终强制对应 type，便于定向构造场景。
// ============================================================================
function _ratioOf(envName, defVal) {
    var v = Number(process.env[envName]);
    if (isNaN(v)) return defVal;
    return Math.min(Math.max(v, 0), 1);
}
const CONFIRM_RATIO = _ratioOf('MOCK_CONFIRM_RATIO', 0.3);
const MISSING_RATIO = _ratioOf('MOCK_MISSING_RATIO', 0.1);

// ============================================================================
// 接口级「整体失败」注入开关（mock 专用，用于验证前端的 errorMsg 弹窗）
//   MOCK_DELETE_FAIL_RATIO  ：删除接口（delete-testAgent-case）整体返回非 SUC0000 的概率
//   MOCK_CONFIRM_FAIL_RATIO ：删除确认接口（delete-testAgent-case-confirm）整体返回非 SUC0000 的概率
//   MOCK_FAIL_CODE          ：失败时的 returnCode（默认 SYS5001）
//   MOCK_FAIL_MSG          ：失败时的 errorMsg（默认「系统繁忙，请稍后重试」）
//   调试前缀：任意 sourceId 以 FAIL_ 开头 → 该次请求强制整体失败（不受比例影响）
// 例如：
//   MOCK_DELETE_FAIL_RATIO=1 node mock-server.js        # 删除接口每次都失败
//   MOCK_CONFIRM_FAIL_RATIO=0.5 node mock-server.js     # 确认接口 50% 概率失败
//
// 与下方「body 内逐条失败」(DELETE_BODY_FAIL_RATIO) 是两个不同维度：
//   · 整体失败注入  → 控制 returnCode，用于验证前端 errorMsg 弹窗
//   · body 内逐条失败 → 控制 body[] 中每条 type='1'成功 / '2'失败，用于验证前端
//                      「部分失败行标红保留、可重试」的展示（接口本身 returnCode 仍为 SUC0000）
// ============================================================================
const DELETE_FAIL_RATIO = _ratioOf('MOCK_DELETE_FAIL_RATIO', 0);
const CONFIRM_FAIL_RATIO = _ratioOf('MOCK_CONFIRM_FAIL_RATIO', 0);
const FAIL_CODE = process.env.MOCK_FAIL_CODE || 'SYS5001';
const FAIL_MSG = process.env.MOCK_FAIL_MSG || '系统繁忙，请稍后重试';
// body 内逐条失败比例（删除接口）：用于控制 body[] 中 type='2' 失败的占比，默认 0.5
const DELETE_BODY_FAIL_RATIO = _ratioOf('MOCK_DELETE_BODY_FAIL_RATIO', 0.5);

/** 判断本次请求是否应整体失败（前缀强制优先于概率） */
function shouldFailOverall(ids, ratio) {
    if (Array.isArray(ids) && ids.some(function (id) { return /^FAIL_/i.test(String(id)); })) {
        return true;
    }
    if (ratio > 0) {
        // 基于「请求首个 sourceId」稳定伪随机，保证同一批 id 多次结果一致
        var seed = Array.isArray(ids) && ids.length ? String(ids[0]) : String(Date.now());
        return stableHash01(seed) < ratio;
    }
    return false;
}

/**
 * 基于字符串的稳定伪随机 [0,1)：同一 sourceId 每次请求结果一致，
 * 便于联调时复现同一批案例的 type 分布。
 */
function stableHash01(s) {
    var h = 2166136261;
    var str = String(s);
    for (var k = 0; k < str.length; k++) {
        h ^= str.charCodeAt(k);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return (h % 100000) / 100000;
}

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
                console.log('  模拟失败: %d / %d 条 (DELETE_BODY_FAIL_RATIO=%s)', failCount, data.length, FAIL_RATIO);
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
    } else if ((req.method === 'DELETE' && req.url === '/api/v1/delete-testAgent-case') ||
               (req.method === 'POST' && req.url === '/test-task/delete-testcase')) {
        // 新契约：DELETE /api/v1/delete-testAgent-case（body 含 operationUser）
        // 旧契约：POST   /test-task/delete-testcase（保留以兼容历史调用）
        var body = '';
        req.on('data', function (chunk) { body += chunk; });
        req.on('end', function () {
            var payload = {};
            try { payload = JSON.parse(body); } catch (e) { payload = {}; }

            var testTaskNo = payload.testTaskNo || '';
            var subTestTaskId = payload.subTestTaskId || '';
            var sourceIds = Array.isArray(payload.sourceIds) ? payload.sourceIds : [];
            var operationUser = payload.operationUser || '';

            var _ts = new Date().toISOString();
            console.log('[%s] 收到删除测试案例请求(%s %s) testTaskNo=%s subTestTaskId=%s operationUser=%s 共 %d 条 sourceIds=%s',
                _ts, req.method, req.url, testTaskNo || '(未提供)', subTestTaskId || '(未提供)',
                operationUser || '(未提供)', sourceIds.length, JSON.stringify(sourceIds));
            console.log('  UA=%s remote=%s:%s', req.headers['user-agent'] || '(无)', req.socket.remoteAddress, req.socket.remotePort);

            // 逐条返回删除结果：type:'1' 成功 / type:'2' 失败 / type:'3' sourceId 不存在
            // 模拟分布：第 3 条（索引 i%3===2）视为 sourceId 不存在 → type:'3'
            //           其余按 DELETE_BODY_FAIL_RATIO 概率返回 type:'1' / type:'2'
            //           （注意：此比例仅控制 body 内 type 分布，接口整体 returnCode 仍为 SUC0000；
            //             若要验证「整体失败弹窗」，改用 MOCK_DELETE_FAIL_RATIO 开关）
            var FAIL_RATIO = DELETE_BODY_FAIL_RATIO;
            var failCount = 0;
            var missingCount = 0;
            var resultBody = sourceIds.map(function (id, i) {
                // sourceId 以 "MISSING" 开头，或直接是第 3 条（i%3===2）→ 模拟线上不存在
                var isMissing = /^MISSING/i.test(String(id)) || (sourceIds.length >= 3 && i % 3 === 2);
                if (isMissing) {
                    missingCount++;
                    return {
                        data: 'sourceId 不存在',
                        sourceId: String(id),
                        type: '3'
                    };
                }
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
            if (failCount > 0 || missingCount > 0) {
                console.log('  模拟结果: 失败 %d / 不存在 %d / 共 %d 条', failCount, missingCount, sourceIds.length);
            }
            if (failCount > 0) {
                console.log('  模拟失败: %d / %d 条 (DELETE_BODY_FAIL_RATIO=%s)', failCount, sourceIds.length, FAIL_RATIO);
            }

            // 接口级整体失败注入：返回非 SUC0000，便于验证前端 errorMsg 弹窗
            if (shouldFailOverall(sourceIds, DELETE_FAIL_RATIO)) {
                console.log('  ⚠ 注入删除接口整体失败 returnCode=%s errorMsg=%s', FAIL_CODE, FAIL_MSG);
                var _fbStr = JSON.stringify({ returnCode: FAIL_CODE, errorMsg: FAIL_MSG, body: [] });
                var _fbBuf = Buffer.from(_fbStr, 'utf8');
                res.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Content-Length': _fbBuf.length,
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type'
                });
                console.log('  ↩ 返回字节流(%d bytes): %s', _fbBuf.length, _fbStr);
                res.end(_fbBuf);
                return;
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
                'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            });
            console.log('  ↩ 返回字节流(%d bytes): %s', _respBuf.length, _respStr);
            res.end(_respBuf);
        });
    } else if ((req.method === 'POST' && req.url === '/api/v1/delete-testAgent-case-confirm') ||
               (req.method === 'POST' && req.url === '/test-task/delete-testcase-confirm')) {
        // 删除确认接口（删除案例前的预检）：入参与「删除案例接口」完全一致，method 统一 POST
        //   新契约：POST /api/v1/delete-testAgent-case-confirm
        //   旧契约：POST /test-task/delete-testcase-confirm（兼容保留）
        // 入参：{ testTaskNo, subTestTaskId, sourceIds, operationUser }
        // 出参：body[] 每项 { sourceId, type, data: { sourceId, testcaseNo, testCaseName, hasExec, hasBug } }
        //   type: 1 允许删除 / 2 需要确认后删除 / 3 案例不存在
        //   type=2 时 hasExec 或 hasBug 至少一个为 true（可同时为 true，也可二选一）
        var body2 = '';
        req.on('data', function (chunk) { body2 += chunk; });
        req.on('end', function () {
            var payload2 = {};
            try { payload2 = JSON.parse(body2); } catch (e) { payload2 = {}; }

            var cTestTaskNo = payload2.testTaskNo || '';
            var cSubTestTaskId = payload2.subTestTaskId || '';
            var cSourceIds = Array.isArray(payload2.sourceIds) ? payload2.sourceIds : [];
            var cOperationUser = payload2.operationUser || '';

            var ts2 = new Date().toISOString();
            console.log('[%s] 收到删除确认请求(%s %s) testTaskNo=%s subTestTaskId=%s operationUser=%s 共 %d 条 sourceIds=%s',
                ts2, req.method, req.url, cTestTaskNo || '(未提供)', cSubTestTaskId || '(未提供)',
                cOperationUser || '(未提供)', cSourceIds.length, JSON.stringify(cSourceIds));

            var allowCount = 0;
            var confirmCount = 0;
            var missingCount2 = 0;
            var stamp = String(Date.now());
            // 有效比例：missing 与 confirm 之和不超过 1，超出时收敛 confirm（保证 missing 优先）
            var mRatio = MISSING_RATIO;
            var cRatio = Math.min(CONFIRM_RATIO, Math.max(0, 1 - mRatio));
            var resultBody2 = cSourceIds.map(function (id, i) {
                var sid = String(id);
                // ① 调试前缀优先（不受比例影响）：CONFIRM_ → type=2，MISSING_ → type=3
                var forcedType = /^CONFIRM/i.test(sid) ? 2 : (/^MISSING/i.test(sid) ? 3 : 0);
                var type;
                if (forcedType) {
                    type = forcedType;
                } else {
                    // ② 按比例分配（基于 sourceId 的稳定伪随机，保证同 id 结果可复现）：
                    //    [0, mRatio)                    → type=3 案例不存在
                    //    [mRatio, mRatio + cRatio)      → type=2 需要确认后删除
                    //    其余                            → type=1 允许直接删除
                    var r = stableHash01(sid);
                    if (r < mRatio) type = 3;
                    else if (r < mRatio + cRatio) type = 2;
                    else type = 1;
                }

                if (type === 3) {
                    missingCount2++;
                    return {
                        sourceId: sid,
                        type: 3,
                        data: { sourceId: sid, testcaseNo: '', testCaseName: '', hasExec: false, hasBug: false }
                    };
                }
                if (type === 2) {
                    confirmCount++;
                    // type=2 时 hasExec / hasBug 至少一个为 true：
                    //   按稳定伪随机分「仅执行 / 仅缺陷 / 两者都有」三种组合
                    var combo = Math.floor(stableHash01(sid + '#combo') * 3); // 0 / 1 / 2
                    var cHasExec = (combo === 0 || combo === 2);
                    var cHasBug = (combo === 1 || combo === 2);
                    // 兜底：极端分布下保证至少一个为 true
                    if (!cHasExec && !cHasBug) cHasExec = true;
                    return {
                        sourceId: sid,
                        type: 2,
                        data: {
                            sourceId: sid,
                            testcaseNo: 'TC' + stamp + (1000 + i),
                            testCaseName: '模拟案例-' + sid,
                            hasExec: cHasExec,
                            hasBug: cHasBug
                        }
                    };
                }
                // ③ type=1 → 允许直接删除（无执行/缺陷关联）
                allowCount++;
                return {
                    sourceId: sid,
                    type: 1,
                    data: {
                        sourceId: sid,
                        testcaseNo: 'TC' + stamp + (1000 + i),
                        testCaseName: '模拟案例-' + sid,
                        hasExec: false,
                        hasBug: false
                    }
                };
            });
            console.log('  模拟确认结果: 允许删除 %d / 需确认 %d / 不存在 %d / 共 %d 条',
                allowCount, confirmCount, missingCount2, cSourceIds.length);

            // 接口级整体失败注入：返回非 SUC0000，便于验证前端 errorMsg 弹窗
            if (shouldFailOverall(cSourceIds, CONFIRM_FAIL_RATIO)) {
                console.log('  ⚠ 注入删除确认接口整体失败 returnCode=%s errorMsg=%s', FAIL_CODE, FAIL_MSG);
                var _cfbStr = JSON.stringify({ returnCode: FAIL_CODE, errorMsg: FAIL_MSG, body: [] });
                var _cfbBuf = Buffer.from(_cfbStr, 'utf8');
                res.writeHead(200, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Content-Length': _cfbBuf.length,
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type'
                });
                console.log('  ↩ 返回字节流(%d bytes): %s', _cfbBuf.length, _cfbStr);
                res.end(_cfbBuf);
                return;
            }

            var responseBody2 = { returnCode: 'SUC0000', errorMsg: '', body: resultBody2 };
            var respStr2 = JSON.stringify(responseBody2);
            var respBuf2 = Buffer.from(respStr2, 'utf8');
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Length': respBuf2.length,
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            });
            console.log('  ↩ 返回字节流(%d bytes): %s', respBuf2.length, respStr2);
            res.end(respBuf2);
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
    console.log('  POST   /test-task/test-case            - 测试案例');
    console.log('  POST   /test-task/push-testcase        - 推送测试案例');
    console.log('  DELETE /api/v1/delete-testAgent-case   - 删除测试案例（新契约）');
    console.log('  POST   /test-task/delete-testcase      - 删除测试案例（旧契约，兼容保留）');
    console.log('  POST   /api/v1/delete-testAgent-case-confirm - 删除确认（新契约，type:1允许/2需确认/3不存在）');
    console.log('  POST   /test-task/delete-testcase-confirm    - 删除确认（旧契约，兼容保留）');
    console.log('  删除确认 type 比例: 需确认(type=2)=' + (CONFIRM_RATIO * 100).toFixed(0) + '%'
        + ', 不存在(type=3)=' + (MISSING_RATIO * 100).toFixed(0) + '%'
        + ', 其余允许删除(type=1)'
        + ' | 可用 MOCK_CONFIRM_RATIO / MOCK_MISSING_RATIO 覆盖');
    console.log('  调试前缀: CONFIRM_ → 强制 type=2, MISSING_ → 强制 type=3（不受比例影响）');
    console.log('  整体失败注入: 删除接口失败率=' + (DELETE_FAIL_RATIO * 100).toFixed(0) + '%'
        + ', 确认接口失败率=' + (CONFIRM_FAIL_RATIO * 100).toFixed(0) + '%'
        + ' | 可用 MOCK_DELETE_FAIL_RATIO / MOCK_CONFIRM_FAIL_RATIO 覆盖（默认 0 不注入）');
    console.log('  失败注入返回码: returnCode=' + FAIL_CODE + ', errorMsg="' + FAIL_MSG + '"'
        + ' | 可用 MOCK_FAIL_CODE / MOCK_FAIL_MSG 覆盖；sourceId 以 FAIL_ 开头强制失败');
    console.log('  body 内逐条失败比例(DELETE_BODY_FAIL_RATIO，不影响 returnCode): '
        + (DELETE_BODY_FAIL_RATIO * 100).toFixed(0) + '%'
        + ' | 可用 MOCK_DELETE_BODY_FAIL_RATIO 覆盖（默认 50%）；用于验证前端部分失败行展示');
    console.log('Total records: ' + TOTAL + ', default pageSize: 200');
});
