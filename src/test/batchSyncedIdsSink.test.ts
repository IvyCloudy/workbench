import { describe, it, expect } from 'vitest';
import { createBatchSyncedIdsSink } from '../utils/batchDeleteSink';

describe('BatchSyncedIdsSink（批量 per-file 明细聚合器）', () => {
    it('appendFromSyncResult：按 filePath 分组累加 tsId，snapshotFiles 保留插入顺序', () => {
        const sink = createBatchSyncedIdsSink();
        sink.appendFromSyncResult('/a/b/foo.testcase', {
            synced: ['t1', 't2', 't3'],
            deletedSuccess: ['t1', 't2'],
            deletedSourceMissing: ['t3'],
        });
        sink.appendFromSyncResult('/a/b/bar.testcase', {
            synced: ['t9'],
            deletedSuccess: [],
            deletedSourceMissing: ['t9'],
        });

        const files = sink.snapshotFiles();
        expect(files).toHaveLength(2);
        // 插入顺序：foo 在前，bar 在后
        expect(files[0].filePath).toBe('/a/b/foo.testcase');
        expect(files[0].syncedTsIds).toEqual(['t1', 't2', 't3']);
        expect(files[0].deletedSuccessIds).toEqual(['t1', 't2']);
        expect(files[0].deletedSourceMissingIds).toEqual(['t3']);
        expect(files[0].hardDeleteOnly).toBe(false);
        expect(files[0].unlinkResult).toBe('unknown');

        expect(files[1].filePath).toBe('/a/b/bar.testcase');
        expect(files[1].syncedTsIds).toEqual(['t9']);

        // 总览：并集，与逐文件 tsId 一致
        const overview = sink.snapshot();
        expect(overview.syncedTsIds).toEqual(['t1', 't2', 't3', 't9']);
        expect(overview.deletedSuccessIds).toEqual(['t1', 't2']);
        expect(overview.deletedSourceMissingIds).toEqual(['t3', 't9']);
    });

    it('同一 filePath 多次 append 合并追加，不去重', () => {
        const sink = createBatchSyncedIdsSink();
        sink.appendFromSyncResult('/x.testcase', {
            synced: ['a', 'b'],
            deletedSuccess: ['a'],
            deletedSourceMissing: ['b'],
        });
        sink.appendFromSyncResult('/x.testcase', {
            synced: ['c'],
            deletedSuccess: ['c'],
            deletedSourceMissing: [],
        });
        const files = sink.snapshotFiles();
        expect(files).toHaveLength(1);
        expect(files[0].syncedTsIds).toEqual(['a', 'b', 'c']);
        expect(files[0].deletedSuccessIds).toEqual(['a', 'c']);
        expect(files[0].deletedSourceMissingIds).toEqual(['b']);
    });

    it('markHardDeleteOnly：即使无 tsId 也保留 per-file 记录，用于 batch.file 上报', () => {
        const sink = createBatchSyncedIdsSink();
        sink.markHardDeleteOnly('/tmp/empty.testcase');
        const files = sink.snapshotFiles();
        expect(files).toHaveLength(1);
        expect(files[0].filePath).toBe('/tmp/empty.testcase');
        expect(files[0].hardDeleteOnly).toBe(true);
        expect(files[0].syncedTsIds).toEqual([]);
        expect(files[0].unlinkResult).toBe('unknown');
    });

    it('recordUnlink：把 finalizeHardDelete 的 unlink 结果写入对应文件记录', () => {
        const sink = createBatchSyncedIdsSink();
        sink.markHardDeleteOnly('/tmp/a.testcase');
        sink.recordUnlink({
            filePath: '/tmp/a.testcase',
            unlinkResult: 'ok',
            errorCode: '',
            errorMessage: '',
            fileSize: 2048,
            hadOpenPanel: true,
        });
        // 另一个文件走 afterSync
        sink.appendFromSyncResult('/tmp/b.testcase', {
            synced: ['t1'],
            deletedSuccess: ['t1'],
            deletedSourceMissing: [],
        });
        sink.recordUnlink({
            filePath: '/tmp/b.testcase',
            unlinkResult: 'failed',
            errorCode: 'EBUSY',
            errorMessage: 'resource busy',
            fileSize: -1,
            hadOpenPanel: false,
        });

        const files = sink.snapshotFiles();
        const a = files.find(f => f.filePath === '/tmp/a.testcase')!;
        const b = files.find(f => f.filePath === '/tmp/b.testcase')!;
        expect(a.unlinkResult).toBe('ok');
        expect(a.fileSize).toBe(2048);
        expect(a.hardDeleteOnly).toBe(true);
        expect(b.unlinkResult).toBe('failed');
        expect(b.unlinkErrorCode).toBe('EBUSY');
        expect(b.syncedTsIds).toEqual(['t1']);
    });

    it('snapshotFiles 返回浅拷贝，外部修改不回灌', () => {
        const sink = createBatchSyncedIdsSink();
        sink.appendFromSyncResult('/x.testcase', {
            synced: ['a'],
            deletedSuccess: ['a'],
            deletedSourceMissing: [],
        });
        const files1 = sink.snapshotFiles();
        files1[0].syncedTsIds.push('MUTATED');
        const files2 = sink.snapshotFiles();
        expect(files2[0].syncedTsIds).toEqual(['a']);
    });

    it('markPrecheckFailed：预检失败文件进入 per-file 明细，unlinkResult 标为 skipped', () => {
        const sink = createBatchSyncedIdsSink();
        sink.markPrecheckFailed('/tmp/blocked.testcase', '关联阻止：存在未关闭的用例');
        // 另外来一个正常同步的文件
        sink.appendFromSyncResult('/tmp/ok.testcase', {
            synced: ['t1'],
            deletedSuccess: ['t1'],
            deletedSourceMissing: [],
        });
        const files = sink.snapshotFiles();
        expect(files).toHaveLength(2);
        const blocked = files.find(f => f.filePath === '/tmp/blocked.testcase')!;
        expect(blocked.precheckFailed).toBe(true);
        expect(blocked.precheckReason).toBe('关联阻止：存在未关闭的用例');
        expect(blocked.unlinkResult).toBe('skipped');
        expect(blocked.syncedTsIds).toEqual([]);
        expect(blocked.deletedSuccessIds).toEqual([]);
        expect(blocked.deletedSourceMissingIds).toEqual([]);
        // 总览：预检失败文件不应污染 tsId 总集
        const overview = sink.snapshot();
        expect(overview.syncedTsIds).toEqual(['t1']);
    });

    it('markPrecheckFailed：超长原因截断到 500 字符，避免拉长上报字段', () => {
        const sink = createBatchSyncedIdsSink();
        const longReason = 'x'.repeat(2000);
        sink.markPrecheckFailed('/tmp/a.testcase', longReason);
        const rec = sink.snapshotFiles()[0];
        expect(rec.precheckReason.length).toBe(500);
        expect(rec.precheckFailed).toBe(true);
    });

    it('markPrecheckFailed + recordUnlink：unlinkResult 以最后写入为准（保守场景防御性用例）', () => {
        const sink = createBatchSyncedIdsSink();
        sink.markPrecheckFailed('/tmp/a.testcase', 'r');
        // 语义上预检失败后不应再走 unlink 上报；此用例仅确保数据结构不崩、字段可被覆盖
        sink.recordUnlink({
            filePath: '/tmp/a.testcase',
            unlinkResult: 'ok',
            errorCode: '',
            errorMessage: '',
            fileSize: 100,
            hadOpenPanel: false,
        });
        const rec = sink.snapshotFiles()[0];
        expect(rec.precheckFailed).toBe(true);
        // recordUnlink 后 unlinkResult 会被覆盖为 'ok'——业务侧靠调用序列保证语义
        expect(rec.unlinkResult).toBe('ok');
    });
});
