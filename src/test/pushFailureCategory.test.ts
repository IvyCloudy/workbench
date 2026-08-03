/**
 * pushFailureCategory · 推送失败分类 / 归类 / 聚合 / 字段聚焦
 * ----------------------------------------------------------------------------
 * 验证：
 *   - classifyBackendFailure 能把后端自由中文长文本归类到稳定 category 短码
 *   - classifyFailure 优先复用结构化信号（validatorKind / mapErrorReason）
 *   - aggregateFailures 按 category 分桶、count 降序、去重保留原文样本
 *   - summarizeCategoryBreakdown 压成 "category:count" 紧凑串供埋点
 *   - extractInterfaceField / failureFieldOf 从错误文本聚焦到具体接口必填字段
 *   - aggregateByField / summarizeFieldBreakdown 按字段聚合
 */
import { describe, it, expect } from 'vitest';
import {
    classifyBackendFailure,
    classifyFailure,
    aggregateFailures,
    summarizeCategoryBreakdown,
    extractInterfaceField,
    failureFieldOf,
    aggregateByField,
    summarizeFieldBreakdown,
    type PushFailCategory,
    type PushInterfaceField,
} from '../utils/pushFailureCategory';

describe('pushFailureCategory · 后端中文长文本归类', () => {
    it('网络/超时 → network', () => {
        expect(classifyBackendFailure('请求超时，请稍后重试')).toBe('network');
        expect(classifyBackendFailure('连接失败 ECONNRESET')).toBe('network');
    });

    it('鉴权/权限 → auth', () => {
        expect(classifyBackendFailure('登录已过期，请重新登录')).toBe('auth');
        expect(classifyBackendFailure('当前用户无权限执行该操作')).toBe('auth');
    });

    it('YAML 语法/解析错误（文件级前置拦截）→ yamlSyntax', () => {
        expect(classifyBackendFailure('YAML 语法错误（首条：第 3 行），共 2 处错误')).toBe('yamlSyntax');
        expect(classifyBackendFailure('YAML 校验器异常：Cannot read property of undefined')).toBe('yamlSyntax');
        // 注意：「文件解析失败: ...」来自 CSV/JSON 解析失败，归 fileError 而非 yamlSyntax
        expect(classifyBackendFailure('文件解析失败: 意外的文件结尾')).toBe('fileError');
        // 纯 YAML 语境解析失败仍归 yamlSyntax
        expect(classifyBackendFailure('YAML 解析失败：unexpected end of file')).toBe('yamlSyntax');
    });

    it('重复/已存在 → 字段.dup 复合码（按命中字段拆）', () => {
        expect(classifyBackendFailure('案例已存在，请勿重复推送')).toBe('sourceId.dup');
    });

    it('字段为空 → 字段.性质复合码（取不到字段时落 fieldEmpty 兜底）', () => {
        expect(classifyBackendFailure('必填字段「名称」不能为空')).toBe('testCaseName.empty');
        expect(classifyBackendFailure('案例信息不能为空')).toBe('caseInfo.empty');
        // 含"缺失"但无明确字段关键词 → 性质级兜底 fieldEmpty
        expect(classifyBackendFailure('必填字段缺失')).toBe('fieldEmpty');
    });

    it('字段长度超限 → 字段.性质复合码', () => {
        expect(classifyBackendFailure('案例名称长度不能超过250个字符')).toBe('testCaseName.length');
        expect(classifyBackendFailure('产出物Id长度不能超过500个字符')).toBe('artifactId.length');
    });

    it('字段格式非法 → 字段.性质复合码', () => {
        expect(classifyBackendFailure('testcase_id 格式不正确')).toBe('sourceId.format');
        expect(classifyBackendFailure('路径格式不正确必须以/结尾')).toBe('testCasePath.format');
        expect(classifyBackendFailure('关键案例格式不正确请填写是或否')).toBe('keyFlag.format');
    });

    it('行内枚举值非法 → 字段.enum 复合码', () => {
        expect(classifyBackendFailure('数据中包含无效的案例类型(界面类/其他)')).toBe('type.enum');
        expect(classifyBackendFailure('数据中包含无效的案例优先级(低/中/高)')).toBe('priority.enum');
        expect(classifyBackendFailure('数据中包含无效的案例默认执行方式(自动化/手工)')).toBe('testType.enum');
    });

    it('检查点数为 0 → checkpointZero（性质唯一，无需复合）', () => {
        expect(classifyBackendFailure('案例检查点数为0请查看预期结果检查分类或填写格式是否正确')).toBe('checkpointZero');
    });

    it('步骤数量不一致 → stepMismatch（性质唯一，无需复合）', () => {
        expect(classifyBackendFailure('步骤描述与预期结果数量不一致')).toBe('stepMismatch');
    });

    it('阶段信息未匹配 → taskStageMissing', () => {
        expect(classifyBackendFailure('测试任务编号未匹配到有效阶段信息或设计人无权限')).toBe('taskStageMissing');
    });

    it('重复/已存在 → 字段.dup 复合码（按命中字段拆）', () => {
        expect(classifyBackendFailure('sourceId已存在')).toBe('sourceId.dup');
        expect(classifyBackendFailure('案例已存在请勿重复添加')).toBe('sourceId.dup');
        // 取不到具体字段的重复 → 性质级兜底 fieldDup
        expect(classifyBackendFailure('数据重复，请检查后重试')).toBe('fieldDup');
    });

    it('任务不存在/未绑定 → taskNotFound（notFound 已拆细）', () => {
        expect(classifyBackendFailure('任务不存在或未绑定')).toBe('taskNotFound');
        expect(classifyBackendFailure('未找到对应测试任务')).toBe('taskNotFound');
    });

    it('测试要点未匹配 → testPointMissing / pathNotMatchPoint（按触发来源拆两种）', () => {
        expect(classifyBackendFailure('任务下未匹配到有效测试要点')).toBe('testPointMissing');
        expect(classifyBackendFailure('案例路径错误未匹配到有效测试要点')).toBe('pathNotMatchPoint');
    });

    it('案例来源被拒 → sourceNotSupported（从 bizReject 拆出）', () => {
        expect(classifyBackendFailure('当前不支持案例来源(testAgent)')).toBe('sourceNotSupported');
        expect(classifyBackendFailure('无效的案例来源(TMS)')).toBe('sourceNotSupported');
    });

    it('其他业务拒绝仍 → bizReject 兜底', () => {
        expect(classifyBackendFailure('此操作被拒绝')).toBe('bizReject');
        expect(classifyBackendFailure('该案例不支持此操作')).toBe('bizReject');
    });

    it('服务端异常/5xx → serverError', () => {
        expect(classifyBackendFailure('系统异常，请稍后再试')).toBe('serverError');
        expect(classifyBackendFailure('服务内部错误 500')).toBe('serverError');
    });

    it('无法归类 → unknown（兜底）', () => {
        expect(classifyBackendFailure('推送处理中，请关注后续通知')).toBe('unknown');
        expect(classifyBackendFailure('')).toBe('unknown');
    });
});

describe('pushFailureCategory · 统一归类入口 classifyFailure', () => {
    it('优先用 validatorKind（占位/空 tsId/格式非法）', () => {
        expect(classifyFailure({ reason: 'x', validatorKind: 'placeholder' })).toBe('placeholder');
        expect(classifyFailure({ reason: 'x', validatorKind: 'empty' })).toBe('emptyTestcaseId');
        // invalidFormat（testcase_id 不符合案例唯一标识规范）→ sourceId.format 复合码
        expect(classifyFailure({ reason: 'testcase_id的值不符合案例唯一标识规范', validatorKind: 'invalidFormat' })).toBe('sourceId.format');
    });

    it('其次用 mapErrorReason（字段映射错误给出字段.性质复合码）', () => {
        expect(classifyFailure({ reason: 'x', mapErrorReason: 'missingTestcaseId' })).toBe('sourceId.empty');
        expect(classifyFailure({ reason: 'x', mapErrorReason: 'missingOperation' })).toBe('description.empty');
        expect(classifyFailure({ reason: 'x', mapErrorReason: 'missingStepDesc' })).toBe('description.empty');
        expect(classifyFailure({ reason: 'x', mapErrorReason: 'missingExpected' })).toBe('expected.empty');
        expect(classifyFailure({ reason: 'x', mapErrorReason: 'invalidPath' })).toBe('testCasePath.format');
        expect(classifyFailure({ reason: 'x', mapErrorReason: 'invalidTestType' })).toBe('testType.enum');
    });

    it('都没有时回退到后端文本归类', () => {
        expect(classifyFailure({ reason: '请求超时' })).toBe('network');
        expect(classifyFailure({ reason: '未知提示' })).toBe('unknown');
    });

    it('文件级前置拦截（pushHandler 中走 error 字符串的场景）', () => {
        expect(classifyFailure({ reason: '文件不在合规目录下（测试任务/<任务文件夹>/测试案例/）' })).toBe('fileError');
        expect(classifyFailure({ reason: '文件解析失败: xxx' })).toBe('fileError');
        expect(classifyFailure({ reason: '文件无有效数据' })).toBe('emptyFile');
        expect(classifyFailure({ reason: '文件无数据' })).toBe('emptyFile');
    });
});

describe('pushFailureCategory · 聚合 aggregateFailures', () => {
    it('按 category 分桶并 count 降序', () => {
        const stats = aggregateFailures([
            { reason: '超时1', category: 'network' as PushFailCategory },
            { reason: '超时2', category: 'network' as PushFailCategory },
            { reason: '无权限', category: 'auth' as PushFailCategory },
        ]);
        expect(stats.map(s => s.category)).toEqual(['network', 'auth']);
        expect(stats[0].count).toBe(2);
        expect(stats[1].count).toBe(1);
    });

    it('同 category 去重保留原文样本（默认最多 2 条）', () => {
        const stats = aggregateFailures([
            { reason: '超时A', category: 'network' as PushFailCategory },
            { reason: '超时A', category: 'network' as PushFailCategory },
            { reason: '超时B', category: 'network' as PushFailCategory },
            { reason: '超时C', category: 'network' as PushFailCategory },
        ]);
        expect(stats).toHaveLength(1);
        expect(stats[0].count).toBe(4);
        expect(stats[0].samples).toEqual(['超时A', '超时B']);
    });

    it('缺 category 时兜底归类', () => {
        const stats = aggregateFailures([{ reason: '请求超时' }, { reason: '无权限' }]);
        expect(stats.find(s => s.category === 'network')?.count).toBe(1);
        expect(stats.find(s => s.category === 'auth')?.count).toBe(1);
    });

    it('unknown 分类不受样本上限约束，保留全部不重复 reason', () => {
        const stats = aggregateFailures([
            { reason: '无法识别的报错甲', category: 'unknown' as PushFailCategory },
            { reason: '无法识别的报错乙', category: 'unknown' as PushFailCategory },
            { reason: '无法识别的报错丙', category: 'unknown' as PushFailCategory },
            { reason: '无法识别的报错丁', category: 'unknown' as PushFailCategory },
            { reason: '无法识别的报错甲', category: 'unknown' as PushFailCategory }, // 重复，去重
        ], 3);
        const unknown = stats.find(s => s.category === 'unknown');
        expect(unknown?.count).toBe(5); // count 含重复
        expect(unknown?.samples).toEqual([
            '无法识别的报错甲',
            '无法识别的报错乙',
            '无法识别的报错丙',
            '无法识别的报错丁',
        ]); // 4 条不重复全部保留，不受 maxSamples=3 限制
    });
});

describe('pushFailureCategory · 埋点紧凑串 summarizeCategoryBreakdown', () => {
    it('category:count 逗号分隔，空聚合返回空串', () => {
        const stats = aggregateFailures([
            { reason: '超时1', category: 'network' as PushFailCategory },
            { reason: '超时2', category: 'network' as PushFailCategory },
            { reason: '无权限', category: 'auth' as PushFailCategory },
        ]);
        expect(summarizeCategoryBreakdown(stats)).toBe('network:2,auth:1');
        expect(summarizeCategoryBreakdown([])).toBe('');
    });
});

describe('pushFailureCategory · 接口字段聚焦 extractInterfaceField / failureFieldOf', () => {
    it('后端报错点名具体字段 → 字段码', () => {
        expect(extractInterfaceField('sourceId 不能为空')).toBe('sourceId');
        expect(extractInterfaceField('testcase_id格式不正确')).toBe('sourceId');
        expect(extractInterfaceField('案例唯一标识缺失')).toBe('sourceId');
        expect(extractInterfaceField('必填字段「名称」不能为空')).toBe('testCaseName');
        expect(extractInterfaceField('案例路径格式错误')).toBe('testCasePath');
        expect(extractInterfaceField('步骤描述不能为空')).toBe('description');
        expect(extractInterfaceField('预期结果为空')).toBe('expected');
    });

    it('无字段关键词 → undefined', () => {
        expect(extractInterfaceField('请求超时，请稍后重试')).toBeUndefined();
        expect(extractInterfaceField('')).toBeUndefined();
    });

    it('mapError 已知字段映射', () => {
        expect(failureFieldOf({ reason: 'x', mapErrorReason: 'missingTestcaseId' })).toBe('sourceId');
        expect(failureFieldOf({ reason: 'x', mapErrorReason: 'missingOperation' })).toBe('description');
        expect(failureFieldOf({ reason: 'x', mapErrorReason: 'missingStepDesc' })).toBe('description');
        expect(failureFieldOf({ reason: 'x', mapErrorReason: 'missingExpected' })).toBe('expected');
        expect(failureFieldOf({ reason: 'x', mapErrorReason: 'invalidPath' })).toBe('testCasePath');
    });

    it('预校验占位/空 tsId/格式非法 → sourceId', () => {
        expect(failureFieldOf({ reason: 'x', validatorKind: 'placeholder' })).toBe('sourceId');
        expect(failureFieldOf({ reason: 'x', validatorKind: 'empty' })).toBe('sourceId');
        expect(failureFieldOf({ reason: 'testcase_id的值不符合案例唯一标识规范', validatorKind: 'invalidFormat' })).toBe('sourceId');
    });

    it('仅字段类错误才聚焦，network/auth 等不误标', () => {
        // auth 文本即使偶含"名称"也不应被打上字段（category 非字段类）
        expect(failureFieldOf({ reason: '当前用户无权限执行该操作' })).toBeUndefined();
        expect(failureFieldOf({ reason: '请求超时' })).toBeUndefined();
        // 字段类（fieldInvalid）才聚焦
        expect(failureFieldOf({ reason: '案例名称为空' })).toBe('testCaseName');
    });
});

describe('pushFailureCategory · 按字段聚合 aggregateByField', () => {
    it('按接口字段分桶并 count 降序', () => {
        const stats = aggregateByField([
            { reason: '名称空', field: 'testCaseName' as PushInterfaceField },
            { reason: '名称空2', field: 'testCaseName' as PushInterfaceField },
            { reason: '路径错', field: 'testCasePath' as PushInterfaceField },
        ]);
        expect(stats.map(s => s.field)).toEqual(['testCaseName', 'testCasePath']);
        expect(stats[0].count).toBe(2);
        expect(stats[1].count).toBe(1);
    });

    it('缺 field 时从 category 复合码取字段（字段类），非字段类不计入', () => {
        const stats = aggregateByField([
            { reason: '案例名称为空' },          // testCaseName.empty → testCaseName
            { reason: '请求超时' },               // network → 无 field，跳过
            { reason: '当前用户无权限' },         // auth → 无 field，跳过
        ]);
        expect(stats).toHaveLength(1);
        expect(stats[0].field).toBe('testCaseName');
        expect(stats[0].count).toBe(1);
    });

    it('summarizeFieldBreakdown 压成 field:count 紧凑串', () => {
        const stats = aggregateByField([
            { reason: 'a', field: 'sourceId' as PushInterfaceField },
            { reason: 'b', field: 'sourceId' as PushInterfaceField },
            { reason: 'c', field: 'testCaseName' as PushInterfaceField },
        ]);
        expect(summarizeFieldBreakdown(stats)).toBe('sourceId:2,testCaseName:1');
        expect(summarizeFieldBreakdown([])).toBe('');
    });
});

/**
 * 29 个真实后端报错场景的端到端覆盖测试。
 * 目标：确保每个报错都能被 classifyFailure 落到正确 category，且能被 failureFieldOf
 * 抽到具体接口字段（field），使埋点 failCategoryBreakdown + failFieldBreakdown 都能下钻。
 */
describe('pushFailureCategory · 29 个真实后端报错场景覆盖', () => {
    /** 单条场景期望：reason 原文 + 期望 category + 期望 field */
    const cases: Array<{ reason: string; category: PushFailCategory; field?: PushInterfaceField }> = [
        // 1. 测试任务编号/子任务Id/设计人/案例来源平台/产出物Id 不能为空（整批接口级必填 → 字段.empty）
        { reason: '测试任务编号不能为空', category: 'testTaskNo.empty', field: 'testTaskNo' },
        { reason: '子任务Id不能为空', category: 'subTestTaskId.empty', field: 'subTestTaskId' },
        { reason: '设计人不能为空', category: 'designer.empty', field: 'designer' },
        { reason: '案例来源平台不能为空', category: 'sourcePlatform.empty', field: 'sourcePlatform' },
        { reason: '产出物Id不能为空', category: 'artifactId.empty', field: 'artifactId' },
        // 2. 产出物Id 长度不能超过 500（字段.length）
        { reason: '产出物Id长度不能超过500个字符', category: 'artifactId.length', field: 'artifactId' },
        // 3. 设计人长度不能超过 200（字段.length）
        { reason: '设计人长度不能超过200个字符', category: 'designer.length', field: 'designer' },
        // 4. 案例信息不能为空（整行必填，归 caseInfo.empty）
        { reason: '案例信息不能为空', category: 'caseInfo.empty', field: 'caseInfo' },
        // 5. 未匹配到有效阶段信息 或 设计人无权限（复合，阶段信息→taskStageMissing + testTaskNo 下钻，早于 auth）
        { reason: '测试任务编号未匹配到有效阶段信息或设计人无权限', category: 'taskStageMissing', field: 'testTaskNo' },
        // 6. 无效的案例来源（sourceNotSupported，不变）
        { reason: '无效的案例来源(TMS/AITEST_CMBT/RFWeb/testAgent/CMBT_TCO/APIAUTO_CMBT/APIAUTO/ARD/DW_AITEST/CMBT_APP/testAgentMA/AITEST/CMBT_APIAUTO/Hippo/CMBT_RF/CMBT_MANUAL/CMBT_AITEST)', category: 'sourceNotSupported', field: 'sourcePlatform' },
        // 7. 当前不支持案例来源（sourceNotSupported，不变）
        { reason: '当前不支持案例来源(testAgent/testAgentMA/CMBT_AITEST)', category: 'sourceNotSupported', field: 'sourcePlatform' },
        // 8. 任务下未匹配到有效测试要点（testPointMissing → testPoint）
        { reason: '任务下未匹配到有效测试要点', category: 'testPointMissing', field: 'testPoint' },
        // 9. 步骤描述不能为空（description.empty）
        { reason: '步骤描述不能为空', category: 'description.empty', field: 'description' },
        // 10. 预期结果不能为空（expected.empty）
        { reason: '预期结果不能为空', category: 'expected.empty', field: 'expected' },
        // 11. 案例来源Id 不能为空（sourceId.empty）
        { reason: '案例来源Id不能为空', category: 'sourceId.empty', field: 'sourceId' },
        // 11b. testcase_id 不符合案例唯一标识规范（sourceId.format）
        { reason: 'testcase_id的值不符合案例唯一标识规范', category: 'sourceId.format', field: 'sourceId' },
        // 12. 案例来源Id 长度不能超过 36（sourceId.length）
        { reason: '案例来源Id长度不能超过36个字符', category: 'sourceId.length', field: 'sourceId' },
        // 13. 案例名称不能为空（testCaseName.empty）
        { reason: '案例名称不能为空', category: 'testCaseName.empty', field: 'testCaseName' },
        // 14. 案例名称长度不能超过 250（testCaseName.length）
        { reason: '案例名称长度不能超过250个字符', category: 'testCaseName.length', field: 'testCaseName' },
        // 15. 案例路径不能为空（testCasePath.empty）
        { reason: '案例路径不能为空', category: 'testCasePath.empty', field: 'testCasePath' },
        // 16. 案例路径长度不能超过 1500（testCasePath.length）
        { reason: '案例路径长度不能超过1500个字符', category: 'testCasePath.length', field: 'testCasePath' },
        // 17. 前置条件长度不能超过 5000（preCondition.length）
        { reason: '前置条件长度不能超过5000个字符', category: 'preCondition.length', field: 'preCondition' },
        // 18. 步骤描述与预期结果数量不一致（stepMismatch → stepSeq）
        { reason: '步骤描述与预期结果数量不一致', category: 'stepMismatch', field: 'stepSeq' },
        // 19. 关键案例不能为空（keyFlag.empty）
        { reason: '关键案例不能为空', category: 'keyFlag.empty', field: 'keyFlag' },
        // 20. 关键案例格式不正确请填写是或否（keyFlag.format）
        { reason: '关键案例格式不正确请填写是或否', category: 'keyFlag.format', field: 'keyFlag' },
        // 21. 无效的案例默认执行方式（行内枚举值非法 → testType.enum）
        { reason: '数据中包含无效的案例默认执行方式(自动化/半自动化/手工)', category: 'testType.enum', field: 'testType' },
        // 22. 无效的案例类型（行内枚举值非法 → type.enum）
        { reason: '数据中包含无效的案例类型(界面类/其他/流程类/批处理类/功能点类/数据仓库类/报表统计类/算法类/安全类/可用性检查类/报文接口类)', category: 'type.enum', field: 'type' },
        // 23. 无效的案例优先级（行内枚举值非法 → priority.enum）
        { reason: '数据中包含无效的案例优先级(低/中/高)', category: 'priority.enum', field: 'priority' },
        // 24. 预期结果长度不能超过 8000（expected.length）
        { reason: '预期结果长度不能超过8000个字符', category: 'expected.length', field: 'expected' },
        // 25. 案例检查点数为0（checkpointZero）
        { reason: '案例检查点数为0请查看预期结果检查分类或填写格式是否正确', category: 'checkpointZero', field: 'expected' },
        // 26. 路径格式不正确必须以/结尾（testCasePath.format）
        { reason: '路径格式不正确必须以/结尾', category: 'testCasePath.format', field: 'testCasePath' },
        // 27. sourceId 已存在（sourceId.dup，按字段拆）
        { reason: 'sourceId已存在', category: 'sourceId.dup', field: 'sourceId' },
        // 28. 案例已存在请勿重复添加（sourceId.dup）
        { reason: '案例已存在请勿重复添加', category: 'sourceId.dup', field: 'sourceId' },
        // 29. 案例路径错误未匹配到有效测试要点（pathNotMatchPoint → testCasePath）
        { reason: '案例路径错误未匹配到有效测试要点', category: 'pathNotMatchPoint', field: 'testCasePath' },
    ];

    for (const c of cases) {
        it(`「${c.reason}」→ category=${c.category}${c.field ? `, field=${c.field}` : ''}`, () => {
            expect(classifyFailure({ reason: c.reason })).toBe(c.category);
            expect(failureFieldOf({ reason: c.reason })).toBe(c.field);
        });
    }

    it('全部 29 个场景均有 field 下钻（无 undefined 丢失维度）', () => {
        const missing = cases.filter(c => failureFieldOf({ reason: c.reason }) === undefined);
        expect(missing).toEqual([]);
    });

    it('pushDataMapper 缺少类 MapError 给出 字段.empty 复合码', () => {
        expect(classifyFailure({ reason: '案例 [abc] 缺少 testcase_id，请补全后再推送。', mapErrorReason: 'missingTestcaseId' })).toBe('sourceId.empty');
        expect(failureFieldOf({ reason: '案例 [abc] 缺少 testcase_id，请补全后再推送。', mapErrorReason: 'missingTestcaseId' })).toBe('sourceId');

        expect(classifyFailure({ reason: '案例 [abc] 缺少「步骤描述」内容，请补全后再推送。', mapErrorReason: 'missingStepDesc' })).toBe('description.empty');
        expect(failureFieldOf({ reason: '案例 [abc] 缺少「步骤描述」内容，请补全后再推送。', mapErrorReason: 'missingStepDesc' })).toBe('description');

        expect(classifyFailure({ reason: '案例 [abc] 缺少「预期结果」，请补全后再推送。', mapErrorReason: 'missingExpected' })).toBe('expected.empty');
        expect(failureFieldOf({ reason: '案例 [abc] 缺少「预期结果」，请补全后再推送。', mapErrorReason: 'missingExpected' })).toBe('expected');

        expect(classifyFailure({ reason: '案例 [abc] 的第 1 个步骤缺少 operation（操作步骤），请补全后再推送。', mapErrorReason: 'missingOperation' })).toBe('description.empty');
        expect(failureFieldOf({ reason: '案例 [abc] 的第 1 个步骤缺少 operation（操作步骤），请补全后再推送。', mapErrorReason: 'missingOperation' })).toBe('description');
    });

    it('pushDataMapper 执行方式不合法（invalidTestType）→ testType.enum', () => {
        expect(classifyFailure({ reason: '案例 [abc] 的「执行方式」取值 "foo" 不合法，仅支持：手工 / UI自动化...', mapErrorReason: 'invalidTestType' })).toBe('testType.enum');
        expect(failureFieldOf({ reason: '案例 [abc] 的「执行方式」取值 "foo" 不合法，仅支持：手工 / UI自动化...', mapErrorReason: 'invalidTestType' })).toBe('testType');
    });

    it('pushCore 样例数据拦截 → sample（带 sourceId 字段）', () => {
        expect(classifyFailure({ reason: '为样例数据，不允许推送。请修改"案例唯一标识，不可修改"等占位字段为真实数据后再试' })).toBe('sample');
        expect(failureFieldOf({ reason: '为样例数据，不允许推送。请修改"案例唯一标识，不可修改"等占位字段为真实数据后再试' })).toBeUndefined();
    });

    it('pushHandler 文件级前置拦截（不在合规目录/解析失败/无数据）→ fileError/emptyFile', () => {
        expect(classifyFailure({ reason: '文件不在合规目录下（测试任务/<任务文件夹>/测试案例/）' })).toBe('fileError');
        expect(classifyFailure({ reason: '文件解析失败: Unexpected token' })).toBe('fileError');
        expect(classifyFailure({ reason: '文件无有效数据' })).toBe('emptyFile');
        expect(classifyFailure({ reason: '文件无数据' })).toBe('emptyFile');
    });
});
