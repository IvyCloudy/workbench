/**
 * ============================================================================
 *  test/waitReady-timer.test.ts
 *  BaseEditorProvider.waitReady 定时器泄漏回归（第 9 轮检视 ι 修复）
 * ----------------------------------------------------------------------------
 *  修复背景：
 *    历史实现里 `Promise.race([entry.ready, timeoutPromise])` 的败者不会
 *    自动清算 —— 当 entry.ready 先 resolve 时，timeoutPromise 内部的
 *    setTimeout 句柄仍在运行到 timeoutMs 才触发（回调无害但持有引用）。
 *    在批量推送场景下（如资源管理器右键批量推送）会累积大量定时器句柄，
 *    导致内存与事件循环负担。
 *
 *    第 9 轮修复：在 `.finally` 块里显式 `clearTimeout(timer)`。
 *  验证策略：
 *    1) spy 全局 setTimeout / clearTimeout，观察调用对
 *    2) ready 先 resolve 场景：验证 clearTimeout 被调用（关键回归点）
 *    3) timeout 先触发场景：验证 clearTimeout 也被调用（timer=null 分支）
 *    4) panel 未注册场景：立即 reject，不产生 timer
 *    5) 批量并发场景：所有 timer 都被 clear，无泄漏
 * ============================================================================
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 打断循环依赖：extensionHelpers → UnifiedEditorProvider → BaseEditorProvider
// 测试环境同步加载会因循环链在 UnifiedEditorProvider extends 未定义的父类而报错。
// mock 掉 UnifiedEditorProvider 让 extensionHelpers 加载时拿到桩，避免触发继承链。
vi.mock('../providers/UnifiedEditorProvider', () => ({
    UnifiedEditorProvider: class { },
    FileTypeChecker: {
        checkFileFormat: () => ({ ok: true }),
    },
}));

// 为了避免 TelemetryService.sendTelemetryErrorEvent 未初始化时抛错，
// 在导入被测模块前 mock 掉 telemetry 模块
vi.mock('../utils/telemetry', () => ({
    TelemetryService: {
        sendTelemetryErrorEvent: vi.fn(),
    },
}));

import { BaseEditorProvider } from '../providers/BaseEditorProvider';

// 直接访问 private static panelMap（TypeScript 编译后只是普通静态属性）
function getPanelMap(): Map<string, any> {
    return (BaseEditorProvider as any).panelMap;
}

function makeMockEntry(readyPromise: Promise<void>) {
    return {
        panel: {} as any,
        ready: readyPromise,
        markReady: () => { },
    };
}

describe('BaseEditorProvider.waitReady 定时器管理（ι 修复）', () => {
    let clearTimeoutSpy: any;
    let setTimeoutSpy: any;

    beforeEach(() => {
        // 清空 panelMap，避免测试间污染
        getPanelMap().clear();
        clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
        setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    });

    afterEach(() => {
        clearTimeoutSpy.mockRestore();
        setTimeoutSpy.mockRestore();
        getPanelMap().clear();
    });

    it('ready 先 resolve —— clearTimeout 必须被调用（核心回归点）', async () => {
        const filePath = '/mock/file-ready-first.yaml';
        // ready 立即 resolve
        getPanelMap().set(filePath, makeMockEntry(Promise.resolve()));

        await BaseEditorProvider.waitReady(filePath, 5000);

        // 关键断言：setTimeout 至少被调用 1 次（waitReady 内部）
        expect(setTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
        // 关键断言：ready 先 resolve 时，finally 必须调用 clearTimeout
        // 若历史实现未清算，这里会为 0，测试失败
        expect(clearTimeoutSpy).toHaveBeenCalled();
    });

    it('timeout 先触发 —— reject 且 finally 分支不重复清算', async () => {
        const filePath = '/mock/file-timeout-first.yaml';
        // ready 永不 resolve，让 timeout 胜出
        getPanelMap().set(filePath, makeMockEntry(new Promise<void>(() => { /* never */ })));

        await expect(BaseEditorProvider.waitReady(filePath, 20)).rejects.toThrow(/超时|等待/);

        // timeout 触发后 timer 内部会被置 null，finally 里的判定应避免重复调用
        // 但至少 setTimeout 被调用过一次
        expect(setTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
        // 契约：修复后的实现里 timeout 回调触发时 timer=null，
        //       finally 走 "if (timer !== null)" 分支跳过 clearTimeout，
        //       即 clearTimeout **不应**被调用（避免重复清算无害但冗余）
        //       —— 这是修复代码里 `timer = null; ... reject(...)` 的一致性验证
        expect(clearTimeoutSpy).not.toHaveBeenCalled();
    });

    it('panel 未注册 —— 立即 reject 且不创建 timer', async () => {
        await expect(BaseEditorProvider.waitReady('/nonexistent.yaml', 5000))
            .rejects.toThrow(/panel 未注册/);

        // 未注册时应在 setTimeout 之前就 return，不产生 timer
        expect(setTimeoutSpy).not.toHaveBeenCalled();
        expect(clearTimeoutSpy).not.toHaveBeenCalled();
    });

    it('批量并发调用 —— 每次 ready 先 resolve 都应清算对应 timer（无泄漏）', async () => {
        // 模拟资源管理器右键批量推送：连续 10 次 waitReady，全部 ready 先 resolve
        const N = 10;
        const paths: string[] = [];
        for (let i = 0; i < N; i++) {
            const fp = '/mock/batch-' + i + '.yaml';
            paths.push(fp);
            getPanelMap().set(fp, makeMockEntry(Promise.resolve()));
        }
        await Promise.all(paths.map(fp => BaseEditorProvider.waitReady(fp, 5000)));

        // 关键：clearTimeout 调用次数 >= N（不 leak）
        expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(N);
    });

    it('ready reject —— finally 分支同样清算 timer', async () => {
        const filePath = '/mock/file-reject.yaml';
        getPanelMap().set(filePath, makeMockEntry(Promise.reject(new Error('boom'))));

        await expect(BaseEditorProvider.waitReady(filePath, 5000)).rejects.toThrow(/boom/);

        // ready reject 会走 finally，同样应触发 clearTimeout（timer 还没到期）
        expect(clearTimeoutSpy).toHaveBeenCalled();
    });
});
