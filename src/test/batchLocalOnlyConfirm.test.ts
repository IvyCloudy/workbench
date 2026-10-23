import { describe, it, expect } from 'vitest';
import { buildLocalOnlyBatchConfirmHtml } from '../utils/batchDeleteConfirmModal';
import type { BatchDeleteFileEntry } from '../utils/batchDeleteConfirmModal';

function makeEntry(over: Partial<BatchDeleteFileEntry> = {}): BatchDeleteFileEntry {
    return {
        filePath: '/p/f.csv',
        fileName: 'f.csv',
        caseCount: 0,
        items: [],
        ...over,
    } as BatchDeleteFileEntry;
}

// ============================================================================
// F2 回归：整批「仅本地删除」（含未绑定任务）应聚合为一条整体提示，
// 不生成逐文件 Tab，且提示中表明文件总数。
// 对应 docs/用户反馈问题-10月.md F2。
// ============================================================================
describe('F2 · 整批本地删除简化确认弹窗', () => {
    it('整批未绑定任务：提示包含文件总数、且不生成逐文件 Tab', () => {
        const entries = [
            makeEntry({ fileName: 'a.csv', unbound: true }),
            makeEntry({ fileName: 'b.csv', unbound: true }),
            makeEntry({ fileName: 'c.csv', unbound: true }),
        ];
        const html = buildLocalOnlyBatchConfirmHtml(entries);
        // 表明文件总数
        expect(html).toContain('共 <b>3</b> 个文件');
        expect(html).toContain('下方清单中 <b>3</b> 个案例文件未绑定测试任务');
        expect(html).toContain('确认后仅删除本地、不同步 TMS 平台');
        // 不向用户暴露内部术语 type=3
        expect(html).not.toContain('type=3');
        // 不应出现逐文件 Tab 的标记
        expect(html).not.toContain('xs-bd-tab');
        expect(html).not.toContain('xs-bd-tabs');
        // 应列出全部文件名
        expect(html).toContain('a.csv');
        expect(html).toContain('b.csv');
        expect(html).toContain('c.csv');
    });

    it('未绑定 + 仅本地 + 未推送 混合：分类计数与总数正确', () => {
        const entries = [
            makeEntry({ fileName: 'u.csv', unbound: true }),
            makeEntry({ fileName: 'h.csv', hardDeleteOnly: true, localRowCount: 5 }),
            makeEntry({ fileName: 't.csv', allType3: true }),
        ];
        const html = buildLocalOnlyBatchConfirmHtml(entries);
        expect(html).toContain('共 <b>3</b> 个文件');
        expect(html).toContain('下方清单中 <b>1</b> 个案例文件未绑定测试任务');
        expect(html).toContain('下方清单中 <b>1</b> 个案例文件为本地专属（无 TMS 记录）');
        expect(html).toContain('下方清单中 <b>1</b> 个案例文件均未推送至 TMS 平台');
        // 未推送类文件的清单 tag 文案，且不暴露内部术语 type=3
        expect(html).toContain('未推送');
        expect(html).not.toContain('type=3');
        expect(html).not.toContain('xs-bd-tab');
    });
});
