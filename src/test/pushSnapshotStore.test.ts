/**
 * ============================================================================
 *  test/pushSnapshotStore.test.ts
 *  pushSnapshotStore end-to-end 回归（第 9 轮检视 γ/δ/ε mtime 缓存修复）
 * ----------------------------------------------------------------------------
 *  修复背景：
 *    - γ：diffPushSnapshot 从"cachedStore 直取"改为统一走 loadStore()，
 *         避免多实例并发场景读到其他窗口写入前的旧缓存。
 *    - δ：saveStore 写完文件后同步刷新 cachedMtimeMs = stat.mtimeMs，
 *         否则下次 loadStore 通过 mtime 判断会误命中"未变更"分支，
 *         把刚写的新数据错认为旧缓存丢弃。
 *    - ε：loadStore 使用 fs.statSync + mtimeMs 判定缓存有效性，
 *         mtimeMs 精度依赖底层文件系统（macOS/APFS 通常纳秒级），
 *         必须验证：文件被外部改动后（模拟其他窗口 / 手动改快照 json），
 *         loadStore 能重新读盘拿到新数据。
 *
 *  验证策略：
 *    1) 用 tmpdir 构造真实快照 JSON 文件，通过 ensureSnapshotFile 挂载
 *    2) savePushSnapshot 建立基线 → diffPushSnapshot 应返回无变化
 *    3) 修改表格数据 → diffPushSnapshot 应准确识别 changed / added / deleted
 *    4) 外部手动改文件（同时更新 mtime）→ 下次 diff 应读到新快照，不用旧缓存
 *    5) 明细表变化 → 通过 detailTables 触发 detail 列高亮
 *    6) 占位样例行 → 全部让位，不进入任何 diff 集合
 * ============================================================================
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// 打断潜在循环依赖（同 waitReady-timer 场景）
vi.mock('../providers/UnifiedEditorProvider', () => ({
    UnifiedEditorProvider: class { },
    FileTypeChecker: { checkFileFormat: () => ({ ok: true }) },
}));
vi.mock('../utils/telemetry', () => ({
    TelemetryService: {
        sendTelemetryEvent: vi.fn(),
        sendTelemetryErrorEvent: vi.fn(),
    },
}));

import {
    ensureSnapshotFile,
    savePushSnapshot,
    diffPushSnapshot,
    removeSnapshotFile,
} from '../utils/pushSnapshotStore';

// ============================================
// 测试工具函数
// ============================================

/** 构造一个假 vscode.ExtensionContext，把 globalStorageUri 指向 tmp 目录 */
function makeFakeContext(dir: string): any {
    return {
        globalStorageUri: { fsPath: dir },
    };
}

/** 简易 tableData 构造器（对齐 diffPushSnapshot 参数结构） */
function makeTable(
    headers: string[],
    rows: any[][],
    detailTables?: any[],
) {
    return { headers, rows, detailTables };
}

/** 睡眠一小段，确保下次 fs 写入 mtime 与上一次不同（macOS APFS 精度足够，这里再兜底一层） */
function sleepMs(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// ============================================
// 测试主体
// ============================================

describe('pushSnapshotStore end-to-end（γ/δ/ε mtime 缓存修复）', () => {
    let tmpDir: string;
    let snapshotFile: string;
    const filePath = '/mock/case_example.yaml'; // 只是快照里的 key，不需要真实存在

    beforeEach(async () => {
        // 每个测试独立 tmpdir，避免污染
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pushSnap-test-'));
        const ctx = makeFakeContext(tmpDir);
        snapshotFile = await ensureSnapshotFile(ctx);
        expect(fs.existsSync(snapshotFile)).toBe(true);
    });

    afterEach(() => {
        try {
            if (fs.existsSync(tmpDir)) {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        } catch { /* ignore */ }
    });

    // -------- 基础：save → diff 往返 --------

    it('无快照时 diffPushSnapshot 返回 null（首次 diff 契约）', () => {
        const table = makeTable(
            ['testcase_id', 'testCaseNo', 'name'],
            [['TC001', 'CN-1', 'foo']],
        );
        const result = diffPushSnapshot('/nonexistent.yaml', table);
        expect(result).toBeNull();
    });

    it('save 后立即 diff（数据未变）—— 无 changed/added/deleted', async () => {
        const headers = ['testcase_id', 'testCaseNo', 'name', 'desc'];
        const rows = [
            ['TC001', 'CN-1', 'name1', 'desc1'],
            ['TC002', 'CN-2', 'name2', 'desc2'],
        ];
        await savePushSnapshot(filePath, makeTable(headers, rows));

        const result = diffPushSnapshot(filePath, makeTable(headers, rows));
        expect(result).not.toBeNull();
        expect(result!.changed).toEqual([]);
        expect(result!.addedInfos).toEqual([]);
        expect(result!.deletedInfos).toEqual([]);
    });

    it('save 后修改某个单元格 —— changed 精确定位 rowIndex 与 changedCols', async () => {
        const headers = ['testcase_id', 'testCaseNo', 'name', 'desc'];
        const rows = [
            ['TC001', 'CN-1', 'name1', 'desc1'],
            ['TC002', 'CN-2', 'name2', 'desc2'],
        ];
        await savePushSnapshot(filePath, makeTable(headers, rows));

        // 改第 2 行的 desc 列（列下标 3）
        const modified = [
            ['TC001', 'CN-1', 'name1', 'desc1'],
            ['TC002', 'CN-2', 'name2', 'DESC2-MODIFIED'],
        ];
        const result = diffPushSnapshot(filePath, makeTable(headers, modified));
        expect(result!.changed).toEqual([{ rowIndex: 1, changedCols: [3] }]);
        expect(result!.addedInfos).toEqual([]);
        expect(result!.deletedInfos).toEqual([]);
    });

    it('testCaseNo 列变化不触发 changed（推送回写不应误标高亮）', async () => {
        const headers = ['testcase_id', 'testCaseNo', 'name'];
        const rows = [['TC001', '', 'name1']];
        await savePushSnapshot(filePath, makeTable(headers, rows));

        // 模拟推送成功后回写 testCaseNo
        const afterPush = [['TC001', 'CN-999', 'name1']];
        const result = diffPushSnapshot(filePath, makeTable(headers, afterPush));
        expect(result!.changed).toEqual([]); // testCaseNo 列被排除
    });

    it('新增行（无 testCaseNo、无失败记录、非占位）—— addedInfos 记录', async () => {
        const headers = ['testcase_id', 'testCaseNo', 'name'];
        const baseRows = [['TC001', 'CN-1', 'n1']];
        await savePushSnapshot(filePath, makeTable(headers, baseRows));

        const withNew = [
            ['TC001', 'CN-1', 'n1'],
            ['TC_NEW', '', 'newRow'], // 用户新增，无 testCaseNo
        ];
        const result = diffPushSnapshot(filePath, makeTable(headers, withNew));
        expect(result!.addedInfos).toEqual([{ rowIndex: 1, tsId: 'TC_NEW' }]);
    });

    it('新增行已带 testCaseNo（快照丢失场景）—— 不判定为 added（防御）', async () => {
        const headers = ['testcase_id', 'testCaseNo', 'name'];
        await savePushSnapshot(filePath, makeTable(headers, [['TC001', 'CN-1', 'n1']]));

        // TC_OLD 快照中不存在但已有 testCaseNo（可能是快照损坏 / tsId 被重生成）
        const withOrphan = [
            ['TC001', 'CN-1', 'n1'],
            ['TC_OLD', 'CN-888', 'orphan'],
        ];
        const result = diffPushSnapshot(filePath, makeTable(headers, withOrphan));
        expect(result!.addedInfos).toEqual([]); // 防御 1：已有 testCaseNo，不标新增
    });

    it('样例/占位行 —— 不参与任何 diff 集合（changed/added/deleted 全让位）', async () => {
        const headers = ['testcase_id', 'testCaseNo', 'name'];
        await savePushSnapshot(filePath, makeTable(headers, [['TC001', 'CN-1', 'ok']]));

        const withSample = [
            ['TC001', 'CN-1', 'ok'],
            ['案例唯一标识，不可修改', '', 'sample-row'], // 长样例
            ['案例唯一标识', '', 'sample-row-short'],     // 短样例
            ['TESTCASE_ID', '', 'placeholder-en'],       // 英文占位
        ];
        const result = diffPushSnapshot(filePath, makeTable(headers, withSample));
        expect(result!.changed).toEqual([]);
        expect(result!.addedInfos).toEqual([]); // 3 个占位行都不算 added
    });

    it('删除行（快照有、当前无、且快照带 testCaseNo）—— deletedInfos 记录', async () => {
        const headers = ['testcase_id', 'testCaseNo', 'name'];
        const rows = [
            ['TC001', 'CN-1', 'n1'],
            ['TC002', 'CN-2', 'n2'], // 后续被删除
        ];
        await savePushSnapshot(filePath, makeTable(headers, rows));

        const afterDelete = [['TC001', 'CN-1', 'n1']];
        const result = diffPushSnapshot(filePath, makeTable(headers, afterDelete));
        expect(result!.deletedInfos).toHaveLength(1);
        expect(result!.deletedInfos[0].tsId).toBe('TC002');
    });

    it('删除行但快照中未推送过（testCaseNo 空）—— 不记录到 deletedInfos', async () => {
        const headers = ['testcase_id', 'testCaseNo', 'name'];
        const rows = [
            ['TC001', 'CN-1', 'n1'],
            ['TC_NEW', '', 'never-pushed'], // 从未推送，只在快照
        ];
        await savePushSnapshot(filePath, makeTable(headers, rows));

        const afterDelete = [['TC001', 'CN-1', 'n1']];
        const result = diffPushSnapshot(filePath, makeTable(headers, afterDelete));
        expect(result!.deletedInfos).toEqual([]); // 未推送过，删了就是删了，无需 ghost 行
    });

    // -------- γ/δ 关键：mtime 缓存一致性 --------

    it('δ 修复：save 后立即 diff（同一进程内）—— 必须读到新快照（不误命中缓存）', async () => {
        // 这个测试直接暴露 δ 修复前的 bug：
        //   saveStore 写完文件但 cachedMtimeMs 没同步刷新 →
        //   loadStore 通过 stat.mtimeMs !== cachedMtimeMs 判定"未变更"→
        //   返回**旧的 cachedStore**（不含刚写入的数据）
        // 修复后：saveStore 内部 `cachedMtimeMs = stat.mtimeMs` 保持一致 → 读到新数据
        const headers = ['testcase_id', 'testCaseNo', 'name'];

        // 第 1 次 save：TC001
        await savePushSnapshot(filePath, makeTable(headers, [['TC001', 'CN-1', 'v1']]));
        let result = diffPushSnapshot(filePath, makeTable(headers, [['TC001', 'CN-1', 'v1']]));
        expect(result!.changed).toEqual([]); // v1 == v1

        // 第 2 次 save：立刻改 TC001 的 name 到 v2 —— 快速连续 save 是 δ 的高危场景
        // 确保 mtime 有变化（macOS/APFS 通常纳秒级，但兜底 sleep 一点）
        await sleepMs(15);
        await savePushSnapshot(filePath, makeTable(headers, [['TC001', 'CN-1', 'v2']]));

        // 用当前数据 v2 与快照 v2 diff —— 若 δ 修复未生效，会命中旧缓存 v1 → changed 有值
        result = diffPushSnapshot(filePath, makeTable(headers, [['TC001', 'CN-1', 'v2']]));
        expect(result!.changed).toEqual([]); // v2 == v2（若失败说明读到了 v1 旧缓存）
    });

    it('ε 修复：外部修改快照文件 + 刷新 mtime —— loadStore 能读到新数据', async () => {
        // 模拟其他窗口写入快照：直接改磁盘 json + touch mtime
        const headers = ['testcase_id', 'testCaseNo', 'name'];

        // 我方先 save 一份基线
        await savePushSnapshot(filePath, makeTable(headers, [['TC001', 'CN-1', 'from-us']]));

        // 外部窗口"偷偷"覆盖快照文件（tsId 从 TC001 变成 TC_OTHER）
        await sleepMs(15);
        const externalContent = JSON.stringify({
            [filePath]: {
                'TC_OTHER': ['TC_OTHER', 'CN-999', 'from-other-window'].join('\x00'),
            },
        });
        fs.writeFileSync(snapshotFile, externalContent, 'utf-8');
        // 显式 touch mtime，确保 fs 层能感知
        const future = new Date(Date.now() + 1000);
        fs.utimesSync(snapshotFile, future, future);

        // 再 diff：此时快照里只有 TC_OTHER，我方当前显示 TC001 → 应识别 added=TC001 + deleted=TC_OTHER
        const result = diffPushSnapshot(
            filePath,
            makeTable(headers, [['TC001', 'CN-1', 'from-us']]),
        );
        expect(result).not.toBeNull();
        // TC001 快照里没有但已有 testCaseNo → 不判 added（防御 1 生效）
        expect(result!.addedInfos).toEqual([]);
        // TC_OTHER 快照有、当前无、且 testCaseNo=CN-999 非空 → 判 deleted
        expect(result!.deletedInfos).toHaveLength(1);
        expect(result!.deletedInfos[0].tsId).toBe('TC_OTHER');
    });

    it('γ 修复：多次 save + diff 交叉调用 —— 一致性不受 cached 状态影响', async () => {
        // γ 修复的产物：diffPushSnapshot 内部改为 loadStore()，
        // 保证每次 diff 走同一条读路径，不会因 "cachedStore 直取" 短路。
        const headers = ['testcase_id', 'testCaseNo', 'name'];

        for (let round = 0; round < 5; round++) {
            const value = 'v' + round;
            await sleepMs(5);
            await savePushSnapshot(filePath, makeTable(headers, [['TC001', 'CN-1', value]]));
            const result = diffPushSnapshot(filePath, makeTable(headers, [['TC001', 'CN-1', value]]));
            expect(result!.changed).toEqual([]); // 每轮都应完全一致
        }
    });

    it('remove 后 diff 返回 null', async () => {
        const headers = ['testcase_id', 'testCaseNo', 'name'];
        await savePushSnapshot(filePath, makeTable(headers, [['TC001', 'CN-1', 'x']]));
        expect(diffPushSnapshot(filePath, makeTable(headers, [['TC001', 'CN-1', 'x']]))).not.toBeNull();

        await removeSnapshotFile(filePath);
        expect(diffPushSnapshot(filePath, makeTable(headers, [['TC001', 'CN-1', 'x']]))).toBeNull();
    });
});
