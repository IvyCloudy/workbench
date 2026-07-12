/**
 * ============================================================================
 *  yaml-telemetry-contract.test.ts
 *  YAML 修复埋点字段合约测试
 * ----------------------------------------------------------------------------
 *  测试目的：
 *    保证 `yaml.fix.applied` 事件的关键字段名（fixCount / fixedLines /
 *    errorFixed / warningFixed / remaining / remainingError / rounds /
 *    scope / severityScope / docLines / initialTotal / cancelled / stoppedByCascade）
 *    在 yamlValidationHandler.ts 源码中"确实出现"，防止未来重构漏改字段名
 *    导致大盘埋点看板报表突然缺列。
 *
 *  实现方式：
 *    read handler 源文件文本 → 断言字段名成对存在于 sendTelemetryEvent
 *    调用体附近。此测试属于"轻量守卫"，只检查字符串出现，不模拟真实调用。
 * ============================================================================
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const HANDLER = path.join(__dirname, '..', 'handlers', 'yamlValidationHandler.ts');

describe('YAML fix telemetry - field contract', () => {
    const src = fs.readFileSync(HANDLER, 'utf8');
    // handler 中有两处 sendTelemetryEvent('yaml.fix.applied'：
    //   · 175 行：Quick Fix 单条上报（只带 fixCount）
    //   · 430+ 行：runYamlFixLoop 批量上报（完整字段清单，本测试要断言）
    // 使用 lastIndexOf 定位到第二处；截取 5000 字符窗口足够覆盖所有字段。
    const idx = src.lastIndexOf("sendTelemetryEvent('yaml.fix.applied'");
    const block = idx >= 0 ? src.substring(idx, idx + 5000) : '';

    it('存在 yaml.fix.applied 埋点调用', () => {
        expect(idx).toBeGreaterThan(0);
    });

    // 修复次数与行数字段
    it.each([
        'fixCount',        // 累计替换次数
        'fixedLines',      // 去重后被修改的行数
    ])('包含"修复量"字段：%s', (field) => {
        expect(block).toContain(field + ':');
    });

    // 严重级增量字段
    it.each([
        'errorFixed',      // 修复的 error 数（增量）
        'warningFixed',    // 修复的 warning 数（增量）
    ])('包含"严重级增量"字段：%s', (field) => {
        expect(block).toContain(field + ':');
    });

    // 上下文字段
    it.each([
        'rounds',          // 迭代轮次
        'scope',           // 修复范围（all / range）
        'severityScope',   // 严重级范围（both / error / warning）
        'docLines',        // 文档总行数
        'initialTotal',    // 修复前总问题数
        'cancelled',       // 是否被用户取消
        'stoppedByCascade',// 是否因级联错误中止
    ])('包含"上下文"字段：%s', (field) => {
        expect(block).toContain(field + ':');
    });

    // 剩余量字段
    it.each([
        'remaining',       // 修复后剩余问题总数
        'remainingError',  // 修复后剩余 error 数
        'remainingWarning',// 修复后剩余 warning 数
    ])('包含"剩余量"字段：%s', (field) => {
        expect(block).toContain(field + ':');
    });

    it('严重级范围枚举值合法（both / error / warning）', () => {
        // severityScope 只能取三种值之一，避免打错字（例如打成 'warn'）
        // 检查方式：severityScope 赋值使用了 severityFilter ?? 'both' 模式
        expect(block).toContain("severityScope: severityFilter ?? 'both'");
    });
});
