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
