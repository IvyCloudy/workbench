/**
 * extensionHelpers · telemetryTsIdListProps 单元测试
 *
 * 覆盖点：
 *   1. 空列表 → key 为空串、Count=0、无 Truncated 字段
 *   2. 短列表 → 完整 join、无 Truncated 字段
 *   3. 超长列表 → 首段完整 join + `|...(+N more)` 后缀，且带 Truncated='true'
 *   4. 多字段并存 → 各字段独立截断，互不影响
 */
import { describe, it, expect, vi } from 'vitest';

// 依赖仅通过 telemetryErrProps 传递到 vscode → stackHead，本函数纯字符串处理，
// 无需 mock vscode / telemetry。但为兼容其它 helper 的 import，仍 mock vscode 空模块。
vi.mock('vscode', () => ({}), { virtual: true });

import { telemetryTsIdListProps } from '../utils/extensionHelpers';

describe('telemetryTsIdListProps · 遥测 tsId 列表压扁', () => {
    it('空列表：key 为空串、Count=0、不带 Truncated', () => {
        const props = telemetryTsIdListProps({ syncedTsIds: [] });
        expect(props.syncedTsIds).toBe('');
        expect(props.syncedTsIdsCount).toBe('0');
        expect(props.syncedTsIdsTruncated).toBeUndefined();
    });

    it('短列表：完整 join，无截断标记', () => {
        const props = telemetryTsIdListProps({
            syncedTsIds: ['TC001', 'TC002', 'TC003'],
        });
        expect(props.syncedTsIds).toBe('TC001|TC002|TC003');
        expect(props.syncedTsIdsCount).toBe('3');
        expect(props.syncedTsIdsTruncated).toBeUndefined();
    });

    it('超长列表：首段完整 + `|...(+N more)` 后缀 + Truncated=true', () => {
        // 构造 1000 条 32 位 hex 风格 tsId，单条长度约 32，加上分隔符总长 ≈ 33000
        // 远超 8000 上限，必然触发截断
        const ids = Array.from({ length: 1000 }, (_, i) => `TCID${String(i).padStart(28, '0')}`);
        const props = telemetryTsIdListProps({ syncedTsIds: ids });

        // Count 字段保留真实数量
        expect(props.syncedTsIdsCount).toBe('1000');
        // 截断标记必须存在
        expect(props.syncedTsIdsTruncated).toBe('true');
        // 截断后的字段必须以 `|...(+N more)` 结尾，且 N > 0
        expect(props.syncedTsIds).toMatch(/\|\.\.\.\(\+\d+ more\)$/);
        // 截断后总长不得超过 8000 字符上限
        expect(props.syncedTsIds.length).toBeLessThanOrEqual(8000);
        // 起始位置应该是第一条 id
        expect(props.syncedTsIds.startsWith(ids[0])).toBe(true);
    });

    it('多字段并存：各字段独立处理，互不影响', () => {
        const longIds = Array.from({ length: 500 }, (_, i) => `LONG${String(i).padStart(30, '0')}`);
        const props = telemetryTsIdListProps({
            syncedTsIds: longIds,
            deletedSuccessIds: ['A', 'B'],
            deletedSourceMissingIds: [],
        });

        // 长字段：被截断
        expect(props.syncedTsIdsTruncated).toBe('true');
        expect(props.syncedTsIds.length).toBeLessThanOrEqual(8000);

        // 短字段：完整保留、无截断标记
        expect(props.deletedSuccessIds).toBe('A|B');
        expect(props.deletedSuccessIdsCount).toBe('2');
        expect(props.deletedSuccessIdsTruncated).toBeUndefined();

        // 空字段：空串 + Count=0
        expect(props.deletedSourceMissingIds).toBe('');
        expect(props.deletedSourceMissingIdsCount).toBe('0');
        expect(props.deletedSourceMissingIdsTruncated).toBeUndefined();
    });
});
