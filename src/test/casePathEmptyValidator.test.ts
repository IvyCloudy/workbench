/**
 * 案例路径非空校验（pathEmpty · error 级）
 * ----------------------------------------------------------------------------
 * 回归场景：案例编辑时，文件中「部分行」path 为空应逐行标红。
 * 路径合法性校验只判定非空 path（需调接口），空值由行级 PATH_EMPTY_VALIDATOR
 * 承担：逐行定位 + field=testCasePath + 剔除行。
 */
import { describe, it, expect } from 'vitest';
import { TS_ID_COLUMN } from '../services/utils';
import { runValidators, runValidatorsOnRowsPure } from '../preValidate/validators';

const TSID_1 = '123e4567-e89b-12d3-a456-426614174000';
const TSID_2 = '223e4567-e89b-12d3-a456-426614174000';

describe('pathEmpty · 案例路径非空（error 级）', () => {
    it('部分行 path 为空 → 仅该行命中，逐行定位且进入 droppedIndex', () => {
        const rows = [
            { [TS_ID_COLUMN]: TSID_1, path: '功能条目/测试要点/' },
            { [TS_ID_COLUMN]: TSID_2, path: '' },
        ];
        const { failuresByKind, droppedIndex } = runValidators(rows as any, i => i + 1);
        const hits = failuresByKind['pathEmpty'] || [];
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({
            tsId: TSID_2,
            reason: '案例路径未填写',
            field: 'testCasePath',
            category: 'testCasePath.empty',
            severity: 'error',
            rowIndex: 2,
        });
        expect(droppedIndex.has(1)).toBe(true);
        expect(droppedIndex.has(0)).toBe(false);
    });

    it('编辑期主通路 runValidatorsOnRowsPure 包含该失败项（path 单元格可染红）', () => {
        const rows = [
            { [TS_ID_COLUMN]: TSID_1, path: '功能条目/测试要点/' },
            { [TS_ID_COLUMN]: TSID_2, path: '' },
        ];
        const failures = runValidatorsOnRowsPure(rows as any, i => i + 1);
        expect(failures.filter(f => f.field === 'testCasePath')).toHaveLength(1);
    });

    it('CSV「路径」列为空 → 命中', () => {
        const rows = [{ [TS_ID_COLUMN]: TSID_1, 路径: '' }];
        const { failuresByKind } = runValidators(rows as any, i => i + 1);
        expect(failuresByKind['pathEmpty']).toHaveLength(1);
    });

    it('表头大小写变体（Path）为空 → 命中（CSV RowLike 以表头原样为 key）', () => {
        const rows = [{ [TS_ID_COLUMN]: TSID_1, Path: '' }];
        const { failuresByKind } = runValidators(rows as any, i => i + 1);
        expect(failuresByKind['pathEmpty']).toHaveLength(1);
    });

    it('path 仅含空白字符 → 命中', () => {
        const rows = [{ [TS_ID_COLUMN]: TSID_1, path: '   ' }];
        const { failuresByKind } = runValidators(rows as any, i => i + 1);
        expect(failuresByKind['pathEmpty']).toHaveLength(1);
    });

    it('字段完全缺省 → 跳过校验（兼容未使用该字段的旧模板）', () => {
        const rows = [{ [TS_ID_COLUMN]: TSID_1, name: '登录用例' }];
        const { failuresByKind } = runValidators(rows as any, i => i + 1);
        expect(failuresByKind['pathEmpty'] ?? []).toHaveLength(0);
    });

    it('path 非空 → 不命中', () => {
        const rows = [{ [TS_ID_COLUMN]: TSID_1, path: '功能条目/测试要点/' }];
        const { failuresByKind } = runValidators(rows as any, i => i + 1);
        expect(failuresByKind['pathEmpty'] ?? []).toHaveLength(0);
    });

    it('规范表头（路径 / Path）值为空 → 仍命中，不再静默跳过', () => {
        for (const header of ['路径', 'Path']) {
            const rows = [{ [TS_ID_COLUMN]: TSID_1, [header]: '' }];
            const { failuresByKind } = runValidators(rows as any, i => i + 1);
            expect(failuresByKind['pathEmpty']).toHaveLength(1);
        }
    });
});
