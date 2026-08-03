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

    it('重复/已存在 → duplicate', () => {
        expect(classifyBackendFailure('案例已存在，请勿重复推送')).toBe('duplicate');
    });

    it('字段不合法/格式错误 → fieldInvalid', () => {
        expect(classifyBackendFailure('testcase_id 格式不正确')).toBe('fieldInvalid');
        expect(classifyBackendFailure('必填字段「名称」不能为空')).toBe('fieldInvalid');
    });

    it('不存在/未找到 → notFound', () => {
        expect(classifyBackendFailure('任务不存在或未绑定')).toBe('notFound');
        expect(classifyBackendFailure('未找到对应测试任务')).toBe('notFound');
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
        expect(classifyFailure({ reason: 'x', validatorKind: 'invalidFormat' })).toBe('fieldInvalid');
    });

    it('其次用 mapErrorReason（字段映射错误）', () => {
        expect(classifyFailure({ reason: 'x', mapErrorReason: 'missingOperation' })).toBe('mapError');
        expect(classifyFailure({ reason: 'x', mapErrorReason: 'invalidPath' })).toBe('mapError');
    });

    it('都没有时回退到后端文本归类', () => {
        expect(classifyFailure({ reason: '请求超时' })).toBe('network');
        expect(classifyFailure({ reason: '未知提示' })).toBe('unknown');
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
        expect(failureFieldOf({ reason: 'x', mapErrorReason: 'invalidPath' })).toBe('testCasePath');
    });

    it('预校验占位/空 tsId/格式非法 → sourceId', () => {
        expect(failureFieldOf({ reason: 'x', validatorKind: 'placeholder' })).toBe('sourceId');
        expect(failureFieldOf({ reason: 'x', validatorKind: 'empty' })).toBe('sourceId');
        expect(failureFieldOf({ reason: 'x', validatorKind: 'invalidFormat' })).toBe('sourceId');
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

    it('缺 field 时兜底抽取（仅字段类），非字段类不计入', () => {
        const stats = aggregateByField([
            { reason: '案例名称为空' },          // fieldInvalid → testCaseName
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
        // 1. 测试任务编号/子任务Id/设计人/案例来源平台/产出物Id 不能为空（整批接口级必填）
        { reason: '测试任务编号不能为空', category: 'fieldInvalid', field: 'testTaskNo' },
        { reason: '子任务Id不能为空', category: 'fieldInvalid', field: 'subTestTaskId' },
        { reason: '设计人不能为空', category: 'fieldInvalid', field: 'designer' },
        { reason: '案例来源平台不能为空', category: 'fieldInvalid', field: 'sourcePlatform' },
        { reason: '产出物Id不能为空', category: 'fieldInvalid', field: 'artifactId' },
        // 2. 产出物Id 长度不能超过 500
        { reason: '产出物Id长度不能超过500个字符', category: 'fieldInvalid', field: 'artifactId' },
        // 3. 设计人长度不能超过 200
        { reason: '设计人长度不能超过200个字符', category: 'fieldInvalid', field: 'designer' },
        // 4. 案例信息不能为空（整行必填，归 caseInfo）
        { reason: '案例信息不能为空', category: 'fieldInvalid', field: 'caseInfo' },
        // 5. 未匹配到有效阶段信息 或 设计人无权限（复合，阶段信息→fieldInvalid+testTaskNo 下钻）
        { reason: '测试任务编号未匹配到有效阶段信息或设计人无权限', category: 'fieldInvalid', field: 'testTaskNo' },
        // 6. 无效的案例来源
        { reason: '无效的案例来源(TMS/AITEST_CMBT/RFWeb/testAgent/CMBT_TCO/APIAUTO_CMBT/APIAUTO/ARD/DW_AITEST/CMBT_APP/testAgentMA/AITEST/CMBT_APIAUTO/Hippo/CMBT_RF/CMBT_MANUAL/CMBT_AITEST)', category: 'bizReject', field: 'sourcePlatform' },
        // 7. 当前不支持案例来源
        { reason: '当前不支持案例来源(testAgent/testAgentMA/CMBT_AITEST)', category: 'bizReject', field: 'sourcePlatform' },
        // 8. 任务下未匹配到有效测试要点（notFound → testPoint）
        { reason: '任务下未匹配到有效测试要点', category: 'notFound', field: 'testPoint' },
        // 9. 步骤描述不能为空
        { reason: '步骤描述不能为空', category: 'fieldInvalid', field: 'description' },
        // 10. 预期结果不能为空
        { reason: '预期结果不能为空', category: 'fieldInvalid', field: 'expected' },
        // 11. 案例来源Id 不能为空
        { reason: '案例来源Id不能为空', category: 'fieldInvalid', field: 'sourceId' },
        // 12. 案例来源Id 长度不能超过 36
        { reason: '案例来源Id长度不能超过36个字符', category: 'fieldInvalid', field: 'sourceId' },
        // 13. 案例名称不能为空
        { reason: '案例名称不能为空', category: 'fieldInvalid', field: 'testCaseName' },
        // 14. 案例名称长度不能超过 250
        { reason: '案例名称长度不能超过250个字符', category: 'fieldInvalid', field: 'testCaseName' },
        // 15. 案例路径不能为空
        { reason: '案例路径不能为空', category: 'fieldInvalid', field: 'testCasePath' },
        // 16. 案例路径长度不能超过 1500
        { reason: '案例路径长度不能超过1500个字符', category: 'fieldInvalid', field: 'testCasePath' },
        // 17. 前置条件长度不能超过 5000
        { reason: '前置条件长度不能超过5000个字符', category: 'fieldInvalid', field: 'preCondition' },
        // 18. 步骤描述与预期结果数量不一致（fieldInvalid → stepSeq）
        { reason: '步骤描述与预期结果数量不一致', category: 'fieldInvalid', field: 'stepSeq' },
        // 19. 关键案例不能为空
        { reason: '关键案例不能为空', category: 'fieldInvalid', field: 'keyFlag' },
        // 20. 关键案例格式不正确请填写是或否
        { reason: '关键案例格式不正确请填写是或否', category: 'fieldInvalid', field: 'keyFlag' },
        // 21. 无效的案例默认执行方式（行内枚举值非法 → fieldInvalid，归 testType）
        { reason: '数据中包含无效的案例默认执行方式(自动化/半自动化/手工)', category: 'fieldInvalid', field: 'testType' },
        // 22. 无效的案例类型（行内枚举值非法 → fieldInvalid，归 type）
        { reason: '数据中包含无效的案例类型(界面类/其他/流程类/批处理类/功能点类/数据仓库类/报表统计类/算法类/安全类/可用性检查类/报文接口类)', category: 'fieldInvalid', field: 'type' },
        // 23. 无效的案例优先级（行内枚举值非法 → fieldInvalid，归 priority）
        { reason: '数据中包含无效的案例优先级(低/中/高)', category: 'fieldInvalid', field: 'priority' },
        // 24. 预期结果长度不能超过 8000
        { reason: '预期结果长度不能超过8000个字符', category: 'fieldInvalid', field: 'expected' },
        // 25. 案例检查点数为0
        { reason: '案例检查点数为0请查看预期结果检查分类或填写格式是否正确', category: 'fieldInvalid', field: 'expected' },
        // 26. 路径格式不正确必须以/结尾
        { reason: '路径格式不正确必须以/结尾', category: 'fieldInvalid', field: 'testCasePath' },
        // 27. sourceId 已存在
        { reason: 'sourceId已存在', category: 'duplicate', field: 'sourceId' },
        // 28. 案例已存在请勿重复添加（duplicate → sourceId）
        { reason: '案例已存在请勿重复添加', category: 'duplicate', field: 'sourceId' },
        // 29. 案例路径错误未匹配到有效测试要点（notFound → testCasePath）
        { reason: '案例路径错误未匹配到有效测试要点', category: 'notFound', field: 'testCasePath' },
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
});
