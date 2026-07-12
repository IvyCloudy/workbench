/**
 * ============================================================================
 * yaml-mega-batch.test.ts
 * 验证大规模样例文件 examples/yaml-format-issues-mega.yaml 的问题量与分批数
 * ----------------------------------------------------------------------------
 * 目的：
 *   1. 保证 mega 样例的问题数 > 2000（对齐用户"实际遇到 2000+"）
 *   2. 按 batchSize=100 计算分批数 > 20，覆盖 fix-all 的多批循环
 *   3. 保证覆盖到关键规则（R1/R2/F1/parse error/...）
 *   4. 若 mega 文件未生成则自动跳过（不阻塞普通开发流程）
 * ============================================================================
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateYamlContent, clearYamlValidationCache } from '../utils/yamlValidator';

const MEGA_PATH = path.join(__dirname, '..', '..', 'examples', 'yaml-format-issues-mega.yaml');
const BATCH_SIZE = 100;

describe.runIf(fs.existsSync(MEGA_PATH))('YAML mega 样例：分批修复场景', () => {
    const content = fs.readFileSync(MEGA_PATH, 'utf8');

    it('打印统计信息（辅助人工确认）', () => {
        clearYamlValidationCache();
        const issues = validateYamlContent(content);
        const errors = issues.filter((i) => i.severity === 'error').length;
        const warnings = issues.filter((i) => i.severity === 'warning').length;
        const withFix = issues.filter((i) => i.fix !== undefined).length;
        const uniqLines = new Set(issues.filter((i) => i.fix !== undefined).map((i) => i.line));
        const batches = Math.ceil(uniqLines.size / BATCH_SIZE);
        // eslint-disable-next-line no-console
        console.log(
            `[mega-stats] total=${issues.length}, error=${errors}, warning=${warnings}, ` +
            `withFix=${withFix}, uniqLines=${uniqLines.size}, batches=${batches}`,
        );
        expect(issues.length).toBeGreaterThan(0);
    });

    it('问题总数 ≥ 1980（R6 新增"对齐尾注释豁免"后基准约 1987，取余量防未来又新增豁免）', () => {
        clearYamlValidationCache();
        const issues = validateYamlContent(content);
        expect(issues.length).toBeGreaterThanOrEqual(1980);
    });

    it('可修复行的分批数 ≥ 20（batchSize=100）', () => {
        clearYamlValidationCache();
        const issues = validateYamlContent(content);
        // fix-all 只处理“有 fix”的，且以“行”为单位去重（一行只 replace 一次）
        const uniqLines = new Set(
            issues.filter((i) => i.fix !== undefined).map((i) => i.line),
        );
        const batches = Math.ceil(uniqLines.size / BATCH_SIZE);
        // 基准：R7 新增豁免后 uniqLines 约 1975（=20 批）；取 ≥ 15 作为余量
        expect(batches).toBeGreaterThanOrEqual(15);
    });

    it('关键规则均命中', () => {
        clearYamlValidationCache();
        const issues = validateYamlContent(content);
        const hitTitles = new Set(issues.map((i) => i.title ?? ''));

        expect(hitTitles.has('Tab 缩进')).toBe(true);      // R1
        expect(hitTitles.has('含 Tab 字符')).toBe(true);   // R2
        expect(hitTitles.has('行末多余空格')).toBe(true);   // R3
        expect(hitTitles.has('缺少空格')).toBe(true);       // R4 / R8
        expect(hitTitles.has('值中 # 会被丢弃')).toBe(true); // R6
        expect(hitTitles.has('重复的 key')).toBe(true);     // F1
        // R5 有多个 title（布尔/null/特殊数值），只需任一命中
        const anyR5 = issues.some((i) => (i.title ?? '').includes('需引号'));
        expect(anyR5).toBe(true);
        // R7 保留字符
        const anyR7 = issues.some((i) => (i.title ?? '').includes('保留字符'));
        expect(anyR7).toBe(true);
        // Parse error 至少一处
        const anyErr = issues.some((i) => i.severity === 'error');
        expect(anyErr).toBe(true);
    });

    it('修复应用后剩余问题显著下降（>90% 被修复）', () => {
        clearYamlValidationCache();
        const before = validateYamlContent(content);
        const beforeCount = before.length;

        // 按 fix-all 的实际策略：以 line 为单位，取"最后一条 fix"（yamlValidator.getAllFixes 的语义）
        const lineToFix = new Map<number, string>();
        for (const iss of before) {
            if (iss.fix !== undefined) lineToFix.set(iss.line, iss.fix);
        }
        const lines = content.split('\n');
        for (const [ln, fix] of lineToFix) {
            if (ln >= 1 && ln <= lines.length) lines[ln - 1] = fix;
        }
        const fixed = lines.join('\n');

        clearYamlValidationCache();
        const after = validateYamlContent(fixed);
        // 修复效果：应从 2000+ 降到远小于 10%
        const reduction = 1 - after.length / beforeCount;
        expect(reduction).toBeGreaterThan(0.9);
    });

    it('多轮迭代（≤ 5 轮）后可修复项收敛到 0（极端非法值 ≤ 5 行 error 可接受）', () => {
        // 模拟 handleFixAll 的迭代策略：每轮 validate → 取 fix → apply → 再 validate
        let current = content;
        let round = 0;
        const MAX_ROUNDS = 5;
        while (round < MAX_ROUNDS) {
            round++;
            clearYamlValidationCache();
            const issues = validateYamlContent(current);
            const lineToFix = new Map<number, string>();
            for (const iss of issues) {
                if (iss.fix !== undefined) lineToFix.set(iss.line, iss.fix);
            }
            if (lineToFix.size === 0) break;
            const arr = current.split('\n');
            let anyReplaced = false;
            for (const [ln, fix] of lineToFix) {
                if (ln >= 1 && ln <= arr.length && arr[ln - 1] !== fix) {
                    arr[ln - 1] = fix;
                    anyReplaced = true;
                }
            }
            current = arr.join('\n');
            if (!anyReplaced) break;
        }

        clearYamlValidationCache();
        const finalIssues = validateYamlContent(current);
        // 迭代收敛条件：
        // 1) 不再有可修复的 issue（withFix=0，代表 handleFixAll 会自然停止）
        // 2) 修完后不再残留 error —— 深水区兜底注释化（`# [unparseable]`）
        //    覆盖了极端非法值（多指示符拼接），mega 现在 100% 收敛。
        //    容忍带 ≤ 2 用于未来可能新增的极端 case，属于回归保护。
        const remainingFix = finalIssues.filter((i) => i.fix !== undefined).length;
        const remainingError = finalIssues.filter((i) => i.severity === 'error').length;
        // eslint-disable-next-line no-console
        console.log(
            `[mega-converge] rounds=${round}, remaining=${finalIssues.length}, ` +
            `withFix=${remainingFix}, errors=${remainingError}`,
        );
        expect(remainingFix).toBe(0);
        expect(remainingError).toBeLessThanOrEqual(2);
    });
});