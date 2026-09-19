/**
 * preValidate/missingColumns · 必备列/字段存在性检查（§2.3.5）
 * ----------------------------------------------------------------------------
 * 覆盖点：
 *   1) CSV：全列齐全 → ok；缺一 / 缺多 / 全缺 → 对应清单；空 headers；
 *   2) YAML/JSON：全键齐全（跨案例聚合）→ ok；某案例缺某键但整体存在 → 不命中；
 *      全文件都缺 → 命中；steps.*_expected 三选一语义；steps.operation 单键；
 *   3) 空文件（空数组）：全部必备键命中；
 *   4) buildMissingColumnMessage / buildMissingColumnReason 展示文案。
 *
 * 由于本模块为纯函数、无 IO、无 vscode 依赖，测试无需 mock；直接构造入参即可。
 */
import { describe, it, expect } from 'vitest';
import {
    detectMissingColumnsForCsv,
    detectMissingColumnsForYamlJson,
    detectMissingColumns,
    buildMissingColumnMessage,
    buildMissingColumnReason,
    REQUIRED_FIELDS,
} from '../preValidate/missingColumns';

const CSV_FULL_HEADERS = [
    'testcase_id', '路径', '名称', '案例描述', '前置条件', '步骤描述', '预期结果', '案例类型', '优先级', '执行方式',
];

describe('missingColumns · CSV 表头判定', () => {
    it('全部必备中文列齐全 → ok=true, missing=[]', () => {
        const r = detectMissingColumnsForCsv(CSV_FULL_HEADERS);
        expect(r.ok).toBe(true);
        expect(r.missing).toEqual([]);
    });

    it('缺一列（缺"路径"）→ 命中一条 "路径"', () => {
        const headers = CSV_FULL_HEADERS.filter(h => h !== '路径');
        const r = detectMissingColumnsForCsv(headers);
        expect(r.ok).toBe(false);
        expect(r.missing).toHaveLength(1);
        expect(r.missing[0].label).toBe('路径');
    });

    it('缺多列（"案例描述"+"预期结果"）→ 命中两条，按 REQUIRED_FIELDS 顺序', () => {
        const headers = CSV_FULL_HEADERS.filter(h => h !== '案例描述' && h !== '预期结果');
        const r = detectMissingColumnsForCsv(headers);
        expect(r.ok).toBe(false);
        expect(r.missing.map(m => m.label)).toEqual(['案例描述', '预期结果']);
    });

    it('空 headers（null / [] / undefined）→ 命中全部必备列', () => {
        const rNull = detectMissingColumnsForCsv(null);
        expect(rNull.ok).toBe(false);
        expect(rNull.missing).toHaveLength(REQUIRED_FIELDS.length);

        const rEmpty = detectMissingColumnsForCsv([]);
        expect(rEmpty.ok).toBe(false);
        expect(rEmpty.missing).toHaveLength(REQUIRED_FIELDS.length);

        const rUndef = detectMissingColumnsForCsv(undefined);
        expect(rUndef.ok).toBe(false);
        expect(rUndef.missing).toHaveLength(REQUIRED_FIELDS.length);
    });

    it('表头带前后空白 → trim 后能命中', () => {
        const headers = CSV_FULL_HEADERS.map(h => ` ${h}  `);
        const r = detectMissingColumnsForCsv(headers);
        expect(r.ok).toBe(true);
    });
});

/**
 * 构造一条"齐全"的 YAML 案例（含所有顶层字段 + steps.operation + steps.*_expected 至少一个）。
 * 便于各用例基于此模板做减法。
 */
function makeFullYamlCase(overrides?: Record<string, any>) {
    return {
        name: 'n',
        path: 'p',
        description: 'd',
        preconditions: ['pc'],
        type: 't',
        test_type: 'tt',
        priority: '中',
        steps: [
            { id: 1, operation: 'op', ui_expected: ['ok'] },
        ],
        ...overrides,
    };
}

describe('missingColumns · YAML/JSON 全文件聚合判定', () => {
    it('单条案例含全部必备键 → ok=true', () => {
        const r = detectMissingColumnsForYamlJson([makeFullYamlCase()]);
        expect(r.ok).toBe(true);
    });

    it('单对象（非数组）也应视为一条案例 → 齐全时 ok=true', () => {
        const r = detectMissingColumnsForYamlJson(makeFullYamlCase());
        expect(r.ok).toBe(true);
    });

    it('空数组 → 命中全部必备键', () => {
        const r = detectMissingColumnsForYamlJson([]);
        expect(r.ok).toBe(false);
        expect(r.missing).toHaveLength(REQUIRED_FIELDS.length);
    });

    it('全文件缺某顶层键（如 path）→ 命中该键', () => {
        const cases = [makeFullYamlCase(), makeFullYamlCase()];
        // 都删掉 path
        cases.forEach(c => { delete (c as any).path; });
        const r = detectMissingColumnsForYamlJson(cases);
        expect(r.ok).toBe(false);
        expect(r.missing.map(m => m.label)).toContain('路径');
    });

    it('中间态：只有一条案例含 path，其它都不含 → 视为存在，不命中（避免误伤中间态）', () => {
        const c1 = makeFullYamlCase();
        const c2 = makeFullYamlCase();
        delete (c2 as any).path;
        const c3 = makeFullYamlCase();
        delete (c3 as any).path;
        const r = detectMissingColumnsForYamlJson([c1, c2, c3]);
        expect(r.ok).toBe(true);
    });

    it('steps.*_expected：任一 step 含 api_expected → 通过（三选一语义）', () => {
        const c = makeFullYamlCase({
            steps: [
                { id: 1, operation: 'op' },
                { id: 2, operation: 'op2', api_expected: ['x'] },
            ],
        });
        const r = detectMissingColumnsForYamlJson([c]);
        expect(r.ok).toBe(true);
    });

    it('steps.*_expected：三者全部缺失 → 命中"预期结果"', () => {
        const c = makeFullYamlCase({
            steps: [
                { id: 1, operation: 'op' },
                { id: 2, operation: 'op2' },
            ],
        });
        const r = detectMissingColumnsForYamlJson([c]);
        expect(r.ok).toBe(false);
        expect(r.missing.map(m => m.label)).toContain('预期结果');
        // 其它顶层字段仍应通过
        expect(r.missing.map(m => m.label)).not.toContain('名称');
    });

    it('steps.operation：所有 step 都缺 operation → 命中"步骤描述"', () => {
        const c = makeFullYamlCase({
            steps: [
                { id: 1, ui_expected: ['ok'] },
                { id: 2, api_expected: ['ok'] },
            ],
        });
        const r = detectMissingColumnsForYamlJson([c]);
        expect(r.ok).toBe(false);
        expect(r.missing.map(m => m.label)).toContain('步骤描述');
    });

    it('steps 为空数组 → 步骤描述 & 预期结果都缺失', () => {
        const c = makeFullYamlCase({ steps: [] });
        const r = detectMissingColumnsForYamlJson([c]);
        expect(r.ok).toBe(false);
        const labels = r.missing.map(m => m.label);
        expect(labels).toContain('步骤描述');
        expect(labels).toContain('预期结果');
    });

    it('sourceData 为 null / undefined → 视为空文件，全部命中', () => {
        expect(detectMissingColumnsForYamlJson(null).missing.length).toBe(REQUIRED_FIELDS.length);
        expect(detectMissingColumnsForYamlJson(undefined).missing.length).toBe(REQUIRED_FIELDS.length);
    });
});

describe('missingColumns · 统一入口 detectMissingColumns 分流', () => {
    it('fileType=csv → 走 headers 判定', () => {
        const r = detectMissingColumns('csv', CSV_FULL_HEADERS, /* sourceData 不影响 */ null);
        expect(r.ok).toBe(true);
    });

    it('fileType=yaml → 走 sourceData 判定（headers 被忽略）', () => {
        const r = detectMissingColumns('yaml', [], [makeFullYamlCase()]);
        expect(r.ok).toBe(true);
    });

    it('fileType=json → 走 sourceData 判定', () => {
        const r = detectMissingColumns('json', undefined, [makeFullYamlCase()]);
        expect(r.ok).toBe(true);
    });

    it('fileType=null → 直接返回 ok（不适用文件类型）', () => {
        const r = detectMissingColumns(null, null, null);
        expect(r.ok).toBe(true);
    });
});

describe('missingColumns · 展示文案', () => {
    it('buildMissingColumnMessage 拼接中文列名', () => {
        const missing = [
            { label: '路径', csvHeader: '路径', yamlKeys: ['path'], location: 'top' as const },
            { label: '案例描述', csvHeader: '案例描述', yamlKeys: ['description'], location: 'top' as const },
        ];
        const msg = buildMissingColumnMessage(missing);
        expect(msg).toContain('路径');
        expect(msg).toContain('案例描述');
        expect(msg).toContain('导致推送失败');
    });

    it('buildMissingColumnMessage 空数组 → 空串', () => {
        expect(buildMissingColumnMessage([])).toBe('');
    });

    it('buildMissingColumnReason 顶层字段 → 包含 yamlKey', () => {
        const reason = buildMissingColumnReason({ label: '路径', csvHeader: '路径', yamlKeys: ['path'], location: 'top' });
        expect(reason).toContain('路径');
        expect(reason).toContain('path');
    });

    it('buildMissingColumnReason 明确表达"文件级"缺失，不误导为单行问题', () => {
        const reason = buildMissingColumnReason({ label: '路径', csvHeader: '路径', yamlKeys: ['path'], location: 'top' });
        // 需求 §2.3.5：文案必须表明这是"当前文件"缺列，避免用户以为某一行有问题
        expect(reason).toContain('当前文件');
        expect(reason).toContain('缺少必备列/字段');
        // 文案精简（2026-09-19）：严重级/行为指引已上给弹窗组头，bullet 不再写"导致推送失败"尾巴
    });

    it('buildMissingColumnReason step 字段 → 包含候选键与 steps[] 前缀', () => {
        const reason = buildMissingColumnReason({
            label: '预期结果',
            csvHeader: '预期结果',
            yamlKeys: ['ui_expected', 'api_expected', 'db_expected'],
            location: 'step',
        });
        expect(reason).toContain('预期结果');
        expect(reason).toContain('steps[]');
        expect(reason).toContain('ui_expected');
        expect(reason).toContain('api_expected');
        expect(reason).toContain('db_expected');
    });

    // ---- fileType 分流（2026-09-19 新增：CSV 纯中文；YAML/JSON 中英文双语）----
    it('buildMissingColumnReason CSV 场景不带 YAML 键后缀（用户面对的就是中文列）', () => {
        const reason = buildMissingColumnReason(
            { label: '路径', csvHeader: '路径', yamlKeys: ['path'], location: 'top' },
            'csv',
        );
        expect(reason).toContain('路径');
        expect(reason).not.toContain('对应 YAML 字段');
        expect(reason).not.toContain('path');
        // 文案精简（2026-09-19）：不再断言"导致推送失败"尾巴
    });

    it('buildMissingColumnReason YAML 场景保留"对应 YAML 字段：xxx"后缀', () => {
        const reason = buildMissingColumnReason(
            { label: '路径', csvHeader: '路径', yamlKeys: ['path'], location: 'top' },
            'yaml',
        );
        expect(reason).toContain('路径');
        expect(reason).toContain('对应 YAML 字段');
        expect(reason).toContain('path');
    });

    it('buildMissingColumnReason JSON 场景与 YAML 一致 → 保留 YAML 键后缀', () => {
        const reason = buildMissingColumnReason(
            { label: '路径', csvHeader: '路径', yamlKeys: ['path'], location: 'top' },
            'json',
        );
        expect(reason).toContain('对应 YAML 字段');
    });

    it('buildMissingColumnMessage CSV 场景 → 仅中文列名，不含英文键', () => {
        const missing = [
            { label: '路径', csvHeader: '路径', yamlKeys: ['path'], location: 'top' as const },
            { label: '预期结果', csvHeader: '预期结果', yamlKeys: ['ui_expected', 'api_expected', 'db_expected'], location: 'step' as const },
        ];
        const msg = buildMissingColumnMessage(missing, 'csv');
        expect(msg).toContain('路径');
        expect(msg).toContain('预期结果');
        expect(msg).not.toContain('path');
        expect(msg).not.toContain('ui_expected');
    });

    it('buildMissingColumnMessage YAML 场景 → 中英文双语（中文（英文键）格式）', () => {
        const missing = [
            { label: '路径', csvHeader: '路径', yamlKeys: ['path'], location: 'top' as const },
            { label: '预期结果', csvHeader: '预期结果', yamlKeys: ['ui_expected', 'api_expected', 'db_expected'], location: 'step' as const },
        ];
        const msg = buildMissingColumnMessage(missing, 'yaml');
        expect(msg).toContain('路径（path）');
        // step 类：三候选键用 " / " 分隔并带 steps[]. 前缀
        expect(msg).toContain('预期结果（steps[].ui_expected / api_expected / db_expected）');
        expect(msg).toContain('导致推送失败');
    });
});
