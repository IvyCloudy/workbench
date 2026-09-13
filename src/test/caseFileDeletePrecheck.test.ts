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