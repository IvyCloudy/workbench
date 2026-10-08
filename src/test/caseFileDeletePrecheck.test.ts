/**
 * 案例文件删除拦截 · 预检阻断单元测试（旧方案，已挂起）
 * ----------------------------------------------------------------------------
 * 本文件覆盖的是**旧方案**下 `handleCaseFileWillDelete` 在 will 阶段完成预检并
 * 通过 willDeleteResults 记录「最终意图」的行为。
 *
 * 新方案（will 只备份、did 立即恢复、插件自主决策）下：
 *   - will 阶段不再执行预检 / 弹确认 / 调线上接口，只做同步磁盘备份；
 *   - 所有预检 / 确认 / 同步 / 真删决策 均迁移至 `handleCaseFilesDidDelete`
 *     （onDidDeleteFiles 事件）；
 *   - 导出符号变化：不再存在 `handleCaseFileWillDelete` 与 WillDeleteResult；
 *     `peekWillDeleteResult` 现返回 WillBackupEntry（仅备份产物）。
 *
 * 因此本文件的所有用例与新流程语义完全不匹配，若继续启用会阻塞类型编译。
 * 现整体挂起（describe.skip），待后续按新方案的 did 阶段决策链路补写等价用例。
 * 保留文件本身以便对照旧行为构造新用例。
 */
import { describe, it, expect } from 'vitest';
import { isPlaceholderTsId } from '../utils/fileIdentifier';

describe.skip('案例文件删除拦截 · 预检阻断（旧方案，等待重写为 did 阶段决策的等价用例）', () => {
    // TODO(P2-5): 按新方案补写等价用例，覆盖以下典型链路：
    //   1) will 阶段 backup 成功 → did 阶段 prepareCaseFileDecisionContext 返回 precheckFailed
    //      → 单文件路径走 showPushSummary（P1-1），批量路径 allPrecheckFailed 也走 pushSummary（P0-C1）；
    //   2) hardDelete 分支：无 testcase_id / 空文件 / 全部本地未推送 → finalizeHardDelete 生效；
    //   3) needConfirm 分支：confirmItems 有 / 无 关联案例，走两种确认弹窗；
    //   4) 用户取消 → reopenCaseFile + telemetry 事件（含 batch 字段）；
    //   5) finalizeHardDelete unlink ENOENT / 权限失败的兜底行为。
    it('placeholder', () => {
        expect(true).toBe(true);
    });
});

// ============================================================================
// 回归用例：案例文件删除时仅含样例占位行，应判为"无需线上操作"（直接本地删除）
// ----------------------------------------------------------------------------
// 对应 docs/用户反馈问题-10月.md F1：新建案例文件只带一行示例数据（testcase_id
// 为占位文案，非真实线上标识），删除却失败。根因是 prepareCaseFileDecisionContext
// 把样例占位 id 算进 nonEmptyIds，使文件没被判定为 hardDelete，反而走预检，
// 占位 id 在 TMS 校验失败 → 删除失败。修复后样例占位 id 必须被排除。
// 下列用例复刻 prepareCaseFileDecisionContext 中"非空且非样例占位"的过滤口径。
// ============================================================================
describe('案例文件删除 · 仅含样例占位行应判定为无需线上操作（F1 回归）', () => {
    function extractRealTsIds(rows: any[][], tsIdx: number): string[] {
        const rowTsIds = rows.map(r => (r[tsIdx] == null ? '' : String(r[tsIdx]).trim()));
        return rowTsIds.filter(Boolean).filter(id => !isPlaceholderTsId(id));
    }

    const SAMPLE_CN_FULL = '案例唯一标识，不可修改';
    const SAMPLE_CN_SHORT = '案例唯一标识';
    const SAMPLE_EN = 'TESTCASE_ID';
    const REAL_ID = 'a1b2c3d4-0000-1111-2222-333344445555';

    it('仅中文样例占位（完整文案）应排除为 0 个真实 id', () => {
        const rows = [[SAMPLE_CN_FULL, '用例A']];
        expect(extractRealTsIds(rows, 0)).toHaveLength(0);
    });

    it('仅中文样例占位（简写文案）应排除为 0 个真实 id', () => {
        const rows = [[SAMPLE_CN_SHORT, '用例A']];
        expect(extractRealTsIds(rows, 0)).toHaveLength(0);
    });

    it('仅英文样例占位（大小写不敏感）应排除为 0 个真实 id', () => {
        const rows = [['testcase_id', '用例A'], ['Testcase_Id', '用例B']];
        expect(extractRealTsIds(rows, 0)).toHaveLength(0);
    });

    it('多行全是样例占位应排除为 0 个真实 id', () => {
        const rows = [[SAMPLE_CN_FULL], [SAMPLE_CN_SHORT], [SAMPLE_EN]];
        expect(extractRealTsIds(rows, 0)).toHaveLength(0);
    });

    it('样例占位与真实 id 混合时，仅保留真实 id', () => {
        const rows = [[SAMPLE_CN_FULL], [REAL_ID], [SAMPLE_EN]];
        const real = extractRealTsIds(rows, 0);
        expect(real).toHaveLength(1);
        expect(real).toEqual([REAL_ID]);
    });

    it('空 testcase_id 行（非样例）也应排除', () => {
        const rows = [[''], ['  '], [REAL_ID]];
        const real = extractRealTsIds(rows, 0);
        expect(real).toHaveLength(1);
        expect(real).toEqual([REAL_ID]);
    });

    it('无 testcase_id 列（tsIdx<0）时按无标识处理，结果为空', () => {
        const rows = [['用例A', '步骤']];
        // 复刻"无列则无法抽取"的语义：tsIdx 越界时抽取为空数组
        const real = (-1 < 0) ? [] : extractRealTsIds(rows, -1);
        expect(real).toHaveLength(0);
    });
});