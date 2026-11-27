/**
 * 新增优先高亮回归测试
 * ----------------------------------------------------------------------------
 * 覆盖两条口径：
 *   1. 前端 resolveHighlight：新增行即使被编辑，也保持绿色且清除 modified；
 *   2. 后端 applyDiffHighlight：新增行不展开进 highlightedCells（修改高亮）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import vm from 'vm';

vi.mock('../utils/highlightStore', () => ({
    setHighlight: vi.fn(async () => {}),
    clearHighlight: vi.fn(async () => {}),
}));
vi.mock('../utils/pushFailureStore', () => ({
    getFailures: vi.fn(() => ({})),
}));
vi.mock('../services/utils', () => ({
    TS_ID_COLUMN: 'testcase_id',
}));
vi.mock('../utils/pushSnapshotStore', () => ({
    diffPushSnapshot: vi.fn(),
}));

import { applyDiffHighlight } from '../services/diffHighlight';
import { setHighlight, clearHighlight } from '../utils/highlightStore';
import { diffPushSnapshot } from '../utils/pushSnapshotStore';

const UTIL_FILE = path.resolve(
    process.cwd(),
    'media/pages/table-editor/editor/highlight/00a-highlight-util.js',
);
const MODEL_FILE = path.resolve(
    process.cwd(),
    'media/pages/table-editor/editor/highlight/00b-highlight-model-write.js',
);

function loadResolveHighlight(): any {
    const sandbox: any = { window: {} };
    vm.runInNewContext(fs.readFileSync(UTIL_FILE, 'utf-8'), sandbox, { filename: UTIL_FILE });
    return sandbox.window.HighlightUtil.resolveHighlight;
}

function loadHighlightModel(): any {
    // createContext + runInContext 确保两次脚本执行与 Set 构造处于同一 realm。
    const context: any = vm.createContext({ window: {} });
    vm.runInContext(fs.readFileSync(UTIL_FILE, 'utf-8'), context, { filename: UTIL_FILE });
    vm.runInContext(fs.readFileSync(MODEL_FILE, 'utf-8'), context, { filename: MODEL_FILE });
    const makeSet = (values: any[]) =>
        vm.runInContext(`new Set(${JSON.stringify(values)})`, context);
    return { model: context.window.HighlightModel, makeSet };
}

describe('resolveHighlight · 新增优先', () => {
    it('新增行存在更晚的本地修改时仍保持绿色并清除 modified', () => {
        const resolveHighlight = loadResolveHighlight();
        const res = resolveHighlight({
            ri: 0,
            ci: 1,
            modTime: 300,
            highlightedCells: {
                colIdx: -1,
                rowIndices: [0],
                cells: new Set(['0:1']),
            },
            highlightedTime: 200,
            addedRowSet: new Set([0]),
            addedRowTime: 100,
            userMarkInfo: null,
            rowFailTime: 0,
        });
        expect(res.bestClass).toBe('xs-td-push-added');
        expect(res.clearModified).toBe(true);
    });

    it('非新增行仍按时间戳竞争，不强制清除 modified', () => {
        const resolveHighlight = loadResolveHighlight();
        const res = resolveHighlight({
            ri: 2,
            ci: 1,
            modTime: 300,
            highlightedCells: {
                colIdx: -1,
                rowIndices: [2],
                cells: new Set(['2:1']),
            },
            highlightedTime: 200,
            addedRowSet: new Set([0]),
            addedRowTime: 100,
            userMarkInfo: null,
            rowFailTime: 0,
        });
        expect(res.bestClass).toBe('');
        expect(res.clearModified).toBe(false);
    });
});

describe('失败行策略 · 仅字段级红底，保留新增状态', () => {
    it('失败行不再产出 push-updated 高亮类', () => {
        const resolveHighlight = loadResolveHighlight();
        const res = resolveHighlight({
            ri: 1,
            ci: 1,
            modTime: 300,
            highlightedCells: {
                colIdx: -1,
                rowIndices: [1],
                cells: new Set(['1:1']),
            },
            highlightedTime: 400,
            addedRowSet: new Set([0]),
            addedRowTime: 100,
            userMarkInfo: null,
            rowFailTime: 200,
        });
        expect(res.bestClass).toBe('');
        expect(res.failOverridden).toBe(true);
    });

    it('clearByPushBatch 保留失败行的新增与修改状态，仅清成功行', () => {
        const { model, makeSet } = loadHighlightModel();
        const S: any = {
            mods: makeSet(['0,1', '1,1']),
            _modsTime: { '0,1': 1, '1,1': 2 },
            _detailModCellKeys: makeSet(['0,1', '1,1']),
            _addedRowSet: makeSet([0, 1]),
            _lastPushBatchRowIndices: [0, 1],
            _lastPushBatchTsIds: makeSet(['TC0', 'TC1']),
        };
        model.clearByPushBatch(S, { rowIndices: [0, 1], failedRowIndices: [1] });
        expect(S.mods.has('0,1')).toBe(false);
        expect(S.mods.has('1,1')).toBe(true);
        expect(S._addedRowSet.has(0)).toBe(false);
        expect(S._addedRowSet.has(1)).toBe(true);
        expect(S._modsTime['1,1']).toBe(2);
    });
});

describe('applyDiffHighlight · 新增行不产生修改高亮', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('只有新增行时清空 highlightedCells，但保留 addedInfos', async () => {
        vi.mocked(diffPushSnapshot).mockReturnValue({
            changed: [],
            deletedInfos: [],
            addedInfos: [{ rowIndex: 0, tsId: 'TC_NEW' }],
        });

        const session: any = {};
        const stats = await applyDiffHighlight(
            '/tmp/cases.yaml',
            session,
            { headers: ['testcase_id'], rows: [['TC_NEW']] },
            () => {},
            { logPrefix: '', emptyDiffHighlight: 'null' },
        );

        expect(stats?.addedRows).toBe(1);
        expect(stats?.modifiedCells).toBe(0);
        expect(session.addedInfos).toEqual([{ rowIndex: 0, tsId: 'TC_NEW' }]);
        expect(session.highlightedCells).toBeNull();
        expect(setHighlight).not.toHaveBeenCalled();
        expect(clearHighlight).toHaveBeenCalledWith('/tmp/cases.yaml');
    });
});
