/**
 * 案例字段口径回归
 * ----------------------------------------------------------------------------
 * 字段取值以推送映射层 utils/pushDataMapper 为准：YAML/JSON 源数据键只有英文，
 * CSV 表头是规范中文列名。缺列校验与行级校验必须对同一表头给出一致结论：
 * 规范表头放行且行级校验能读到；中文变体表头由缺列校验在文件层拦下
 * （否则推送 mapper 读不到 name/path，会产出空字段）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    CASE_NAME_COLUMN_ALIASES,
    CASE_PATH_COLUMN_ALIASES,
    findCaseColumnIndex,
} from '../utils/caseRowFields';
import {
    detectMissingColumnsForCsv,
    detectMissingColumnsForYamlJson,
    REQUIRED_FIELDS,
} from '../preValidate/missingColumns';
import { runValidators } from '../preValidate/validators';
import { TS_ID_COLUMN } from '../services/utils';

const VALID_TSID = '123e4567-e89b-12d3-a456-426614174000';
const CSV_FULL_HEADERS = [
    'testcase_id', '路径', '名称', '案例描述', '前置条件', '步骤描述', '预期结果', '案例类型', '优先级', '执行方式',
];
const idx = (i: number) => i + 1;

function highlightAliasesOf(fieldCode: string): string[] {
    const js = fs.readFileSync(
        path.join(process.cwd(), 'media/pages/table-editor/editor/highlight/00a-highlight-util.js'),
        'utf8',
    );
    const m = js.match(new RegExp(`${fieldCode}:\\s*\\[([^\\]]*)\\]`));
    if (!m) return [];
    return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

describe('字段口径 · 规范键', () => {
    it('行字段别名只含 YAML 英文键 + CSV 规范中文列名', () => {
        expect([...CASE_PATH_COLUMN_ALIASES]).toEqual(['path', '路径']);
        expect([...CASE_NAME_COLUMN_ALIASES]).toEqual(['name', '名称']);
    });

    it('缺列校验的名称/路径只额外兼容英文键，不放行中文变体', () => {
        expect(REQUIRED_FIELDS.find(s => s.label === '名称')?.csvAliases).toEqual(['name']);
        expect(REQUIRED_FIELDS.find(s => s.label === '路径')?.csvAliases).toEqual(['path']);
    });

    it('前端高亮覆盖 YAML 英文键与 CSV 规范中文列名', () => {
        expect(highlightAliasesOf('testCasePath')).toEqual(expect.arrayContaining(['path', '路径']));
        expect(highlightAliasesOf('testCaseName')).toEqual(expect.arrayContaining(['name', '名称']));
    });
});

describe('字段口径 · 缺列判定与行级校验一致', () => {
    it('规范中文表头：缺列不命中，空值仍被行级校验硬拦截', () => {
        expect(detectMissingColumnsForCsv(CSV_FULL_HEADERS).ok).toBe(true);
        const rows = [{ [TS_ID_COLUMN]: VALID_TSID, 名称: '', 路径: '' }];
        const { failuresByKind } = runValidators(rows as any, idx);
        expect(failuresByKind['nameEmpty']).toHaveLength(1);
        expect(failuresByKind['pathEmpty']).toHaveLength(1);
    });

    it('英文键表头：空值仍被行级校验硬拦截', () => {
        const rows = [{ [TS_ID_COLUMN]: VALID_TSID, name: '', path: '' }];
        const { failuresByKind } = runValidators(rows as any, idx);
        expect(failuresByKind['nameEmpty']).toHaveLength(1);
        expect(failuresByKind['pathEmpty']).toHaveLength(1);
    });

    it('中文变体表头由缺列校验拦下（推送 mapper 读不到这些键）', () => {
        const nameHeaders = CSV_FULL_HEADERS.map(h => h === '名称' ? '案例名称' : h);
        expect(detectMissingColumnsForCsv(nameHeaders).missing.map(m => m.label)).toContain('名称');
        const pathHeaders = CSV_FULL_HEADERS.map(h => h === '路径' ? '案例路径' : h);
        expect(detectMissingColumnsForCsv(pathHeaders).missing.map(m => m.label)).toContain('路径');
        expect(findCaseColumnIndex(['testcase_id', '案例路径'], CASE_PATH_COLUMN_ALIASES)).toBe(-1);
    });
});

describe('字段口径 · YAML/JSON 只按英文键判定', () => {
    const fullYamlCase = {
        name: 'n', path: 'p', preconditions: ['pc'], test_type: 'tt', priority: '中',
        steps: [{ operation: 'op', ui_expected: ['ok'] }],
    };

    it('英文键齐全 → 缺列不命中', () => {
        expect(detectMissingColumnsForYamlJson([fullYamlCase]).ok).toBe(true);
    });

    it('中文显示名不是 YAML 数据键 → 仍判缺列', () => {
        const r = detectMissingColumnsForYamlJson([{
            '名称': 'n', '路径': 'p', preconditions: ['pc'], test_type: 'tt', priority: '中',
            steps: [{ operation: 'op', ui_expected: ['ok'] }],
        }]);
        expect(r.missing.map(m => m.label)).toEqual(expect.arrayContaining(['名称', '路径']));
    });
});
