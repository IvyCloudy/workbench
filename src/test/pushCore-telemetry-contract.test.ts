/**
 * ============================================================================
 *  pushCore-telemetry-contract.test.ts
 *  推送结果埋点字段合约测试（失败分类维度 + 接口字段聚焦维度）
 * ----------------------------------------------------------------------------
 *  测试目的：
 *    保证「失败分类」维度（failCategoryBreakdown / topFailCategory）与
 *    「接口字段聚焦」维度（failFieldBreakdown / topFailField）以及分层维度
 *    （interface* / case*）确实存在于推送结局埋点的运行时 payload 中，
 *    防止未来重构漏改字段名导致大盘看板缺列。
 *
 *  实现方式：
 *    与 yaml-telemetry-contract.test.ts 一致——读取源码文本、断言字段名出现。
 *    属于"轻量守卫"，只检查字符串出现，不模拟真实调用。
 *
 *  重构说明（buildFailDimensions 收口）：
 *    所有失败结局事件（3 个 .aborted 分支 + .complete + batch.fileResult +
 *    batch.done）的失败维度 props 均由 pushCore.ts 导出的 buildFailDimensions()
 *    统一产出，并通过 `...buildFailDimensions(...)` 展开。因此字段名只在该函数
 *    内出现一次，外部事件只需校验"调用了 buildFailDimensions"即可保证字段齐全。
 * ============================================================================
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const PUSH_CORE = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'pushCore.ts'), 'utf8');
const PUSH_HANDLER = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'pushHandler.ts'), 'utf8');

describe('pushCore 失败分类 + 字段聚焦埋点字段合约（buildFailDimensions 收口）', () => {
    // —— 1. buildFailDimensions 是失败维度的唯一事实来源，必须包含全部维度字段名 ——
    it('buildFailDimensions 产出全部失败分类 / 字段聚焦 / 分层维度字段', () => {
        const fnIdx = PUSH_CORE.indexOf('export function buildFailDimensions');
        expect(fnIdx, '源码中应存在 buildFailDimensions 导出函数').toBeGreaterThan(0);
        const fnEnd = PUSH_CORE.indexOf('\n}', fnIdx);
        const block = PUSH_CORE.substring(fnIdx, fnEnd > fnIdx ? fnEnd : fnIdx + 2000);
        for (const f of [
            'failCategoryBreakdown', 'topFailCategory',
            'failFieldBreakdown', 'topFailField',
            'interfaceFailBreakdown', 'topInterfaceFailField',
            'caseFailBreakdown', 'topCaseFailField',
            'auxFieldRawSamples',
            'taskNotFoundSamples', 'testPointMissingSamples', 'pathNotMatchPointSamples',
            'sourceNotSupportedSamples', 'paramFormatSamples', 'fieldInvalidSamples',
            'unknownSamples',
        ]) {
            expect(block, `buildFailDimensions 缺少维度字段 ${f}`).toContain(f);
        }
    });

    // —— 2. 分层维度由 aggregateByField + summarizeFieldBreakdown(_, level) 生成 ——
    it('分层维度由 aggregateByField + summarizeFieldBreakdown(_, interface|case) 生成', () => {
        const fnIdx = PUSH_CORE.indexOf('export function buildFailDimensions');
        const fnEnd = PUSH_CORE.indexOf('\n}', fnIdx);
        const block = PUSH_CORE.substring(fnIdx, fnEnd > fnIdx ? fnEnd : fnIdx + 2000);
        expect(block).toContain('aggregateByField(');
        expect(block).toContain("summarizeFieldBreakdown(fieldStats, 'interface')");
        expect(block).toContain("summarizeFieldBreakdown(fieldStats, 'case')");
        expect(block).toContain('topFieldOfLevel(');
    });

    // —— 3. 失败分类维度由 aggregateFailures + summarizeCategoryBreakdown 生成 ——
    it('失败分类维度由 aggregateFailures + summarizeCategoryBreakdown 生成', () => {
        const fnIdx = PUSH_CORE.indexOf('export function buildFailDimensions');
        const fnEnd = PUSH_CORE.indexOf('\n}', fnIdx);
        const block = PUSH_CORE.substring(fnIdx, fnEnd > fnIdx ? fnEnd : fnIdx + 2000);
        expect(block).toContain('aggregateFailures(');
        expect(block).toContain('summarizeCategoryBreakdown(');
    });

    // —— 4. 各失败结局事件通过 ...buildFailDimensions(...) 展开，保证字段齐全且不重复拼装 ——
    const events = [
        { name: 'pushCore 全剔除 .aborted', src: PUSH_CORE, marker: "emitAborted(ctx, pickAllDroppedReason(pre.byKind)," },
        { name: 'pushCore 样例+预校验 .aborted', src: PUSH_CORE, marker: "emitAborted(ctx, 'onlyTemplateExampleAndPreValidationFailed'," },
        { name: 'pushCore 纯样例 .aborted', src: PUSH_CORE, marker: "emitAborted(ctx, 'onlyTemplateExample'," },
        { name: 'pushCore .complete', src: PUSH_CORE, marker: "${ctx.telemetryPrefix}.complete`" },
        { name: 'pushHandler batch.fileResult', src: PUSH_HANDLER, marker: "'explorerPush.batch.fileResult'" },
        { name: 'pushHandler batch.done', src: PUSH_HANDLER, marker: "'explorerPush.batch.done'" },
    ];

    for (const ev of events) {
        it(`事件 ${ev.name} 通过 ...buildFailDimensions(...) 携带失败维度`, () => {
            const idx = ev.src.indexOf(ev.marker);
            expect(idx, `未找到事件标记: ${ev.marker}`).toBeGreaterThan(0);
            // 取足够窗口覆盖到展开点（含后续 costMs / 闭合）
            const block = ev.src.substring(idx, idx + 1400);
            expect(block, `事件 ${ev.name} 未展开 buildFailDimensions`).toContain('...buildFailDimensions(');
        });
    }

    // —— 5. 主路径失败维度已由 buildFailDimensions 收口，未在各结局事件内重复硬编码 ——
    it('主路径失败维度由 buildFailDimensions 收口（pushHandler 批量/单文件结局事件不再手工拼装）', () => {
        // batch.fileResult / batch.done / YAML 前置校验分支均通过 ...buildFailDimensions( 展开引入全部维度，
        // 不应再手工出现 failCategoryBreakdown 字面量
        const handlerCalls = PUSH_HANDLER.split('...buildFailDimensions(').length - 1;
        expect(handlerCalls, 'pushHandler 应通过 ...buildFailDimensions( 展开').toBeGreaterThanOrEqual(3);
    });

    // —— 8. pushHandler 调度层 .aborted 与 runPush 执行层 .aborted 字段口径对齐（traceId / costMs）——
    it('pushHandler 调度层 .aborted 携带 traceId + costMs（与 runPush 执行层对齐）', () => {
        // 调度层 6 个中断分支（noFiles / dirNotQualified / yamlSyntaxError / yamlValidatorCrash /
        // parseError / emptyFile）均应带上 traceId + costMs，且 YAML 两处失败维度走 buildFailDimensions 收口。
        const reasons = [
            'noFiles', 'dirNotQualified', 'yamlSyntaxError',
            'yamlValidatorCrash', 'parseError', 'emptyFile',
        ];
        for (const reason of reasons) {
            const idx = PUSH_HANDLER.indexOf(`reason: '${reason}'`);
            expect(idx, `未找到 .aborted 分支: ${reason}`).toBeGreaterThan(0);
            const block = PUSH_HANDLER.substring(idx, idx + 400);
            expect(block, `.aborted(${reason}) 应携带 traceId`).toContain('traceId:');
            expect(block, `.aborted(${reason}) 应携带 costMs`).toContain('costMs:');
        }
        // YAML 两处前置校验分支的失败维度应由 buildFailDimensions 统一收口（不再手工内联 failCategoryBreakdown）
        const yamlInline = PUSH_HANDLER.split('failCategoryBreakdown: summarizeCategoryBreakdown(').length - 1;
        expect(yamlInline, 'YAML 分支不应再手工内联 failCategoryBreakdown').toBe(0);
    });

    // —— 6. batch.fileResult 与单文件 .complete 字段口径对齐（防止格式再次分叉）——
    it('batch.fileResult 与 .complete 字段对齐（pushResult / preValidationFailedRows / traceId / costMs）', () => {
        // batch.fileResult 必须采用与 .complete 一致的 pushResult 命名（而非旧的 resultType），
        // 并补齐此前缺失的 preValidationFailedRows / traceId / costMs，逐文件损失链路维度。
        const idx = PUSH_HANDLER.indexOf("'explorerPush.batch.fileResult'");
        expect(idx, "未找到 batch.fileResult 事件").toBeGreaterThan(0);
        const block = PUSH_HANDLER.substring(idx, idx + 1500);
        expect(block, 'batch.fileResult 应使用 pushResult 命名（对齐 .complete）').toContain('pushResult,');
        expect(block, 'batch.fileResult 应携带 preValidationFailedRows').toContain('preValidationFailedRows:');
        expect(block, 'batch.fileResult 应携带 traceId').toContain('traceId:');
        expect(block, 'batch.fileResult 应携带 costMs').toContain('costMs:');
        // 确认已移除旧的 resultType 字段名，避免双口径并存
        expect(block, 'batch.fileResult 不应再使用旧 resultType 命名').not.toContain('resultType');
    });

    // —— 7. .aborted 各中断分支均携带 costMs（与 .complete 对齐耗时维度）——
    it('.aborted 所有触发分支均携带 costMs', () => {
        // 所有 .aborted 发送已收敛到 emitAborted(ctx, reason, extra?) 封装：
        // 公共字段 + costMs 在该封装内统一注入，调用点不应再出现裸 sendTelemetryEvent(`${prefix}.aborted`
        const emitMarker = 'emitAborted(ctx,';
        const emitIdxs: number[] = [];
        let from = PUSH_CORE.indexOf(emitMarker);
        while (from > 0) {
            emitIdxs.push(from);
            from = PUSH_CORE.indexOf(emitMarker, from + 1);
        }
        expect(emitIdxs.length, '源码中应存在 >=6 个 .aborted 中断分支').toBeGreaterThanOrEqual(6);

        // 封装定义内部必须统一注入 costMs（保证所有分支不遗漏）
        const defIdx = PUSH_CORE.indexOf('function emitAborted(');
        expect(defIdx, '应存在 emitAborted 封装定义').toBeGreaterThan(0);
        const defBlock = PUSH_CORE.substring(defIdx, defIdx + 600);
        expect(defBlock, 'emitAborted 封装必须统一注入 costMs').toContain('costMs:');

        // 除 emitAborted 封装定义体内那一处外，不应残留裸的 sendTelemetryEvent(`${prefix}.aborted` 调用
        const rawMarker = "sendTelemetryEvent(`${ctx.telemetryPrefix}.aborted`";
        const rawIdx = PUSH_CORE.indexOf(rawMarker);
        expect(rawIdx, '应至少存在封装定义内的裸 .aborted 发送').toBeGreaterThan(0);
        // 该裸调用必须位于 emitAborted 定义内（封装本身），而非其它分支
        expect(rawIdx, '裸 .aborted 调用应位于 emitAborted 封装定义内').toBeGreaterThan(defIdx);
        expect(rawIdx, '裸 .aborted 调用不应超出 emitAborted 封装定义范围').toBeLessThan(defIdx + 600);
    });
});
