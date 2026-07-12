/**
 * ============================================================================
 *  checkYamlParseable 单元测试
 * ----------------------------------------------------------------------------
 *  覆盖场景：
 *    - 合法 YAML（顶层单对象 / 顶层数组 / 空文件 / 全注释）→ ok=true
 *    - 语法错误（未闭合引号 / mapping 列不齐 / 重复 key）→ ok=false，且给出 errorLine
 *    - 修复后的 mega 文件（模拟 fix-all 收敛后）→ ok=true
 * ============================================================================
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { checkYamlParseable } from '../parsers/yaml-parse-check';

describe('checkYamlParseable', () => {
    it('空字符串 → 视为可解析', () => {
        expect(checkYamlParseable('')).toEqual({ ok: true });
        expect(checkYamlParseable('   \n  \n').ok).toBe(true);
    });

    it('全注释文件 → 视为可解析', () => {
        expect(checkYamlParseable('# only comment\n# another\n').ok).toBe(true);
    });

    it('顶层单对象 → 可解析', () => {
        const yaml = 'name: hello\ndesc: world\n';
        expect(checkYamlParseable(yaml).ok).toBe(true);
    });

    it('顶层数组多条案例 → 可解析', () => {
        const yaml = '- name: a\n  desc: x\n- name: b\n  desc: y\n';
        expect(checkYamlParseable(yaml).ok).toBe(true);
    });

    it('未闭合引号 → 不可解析，给出 errorLine', () => {
        const yaml = 'name: "hello\ndesc: world\n';
        const r = checkYamlParseable(yaml);
        expect(r.ok).toBe(false);
        expect(typeof r.errorLine).toBe('number');
        expect(r.errorMessage).toBeTruthy();
    });

    it('mapping 列不齐 → 不可解析', () => {
        const yaml = 'a: 1\n b: 2\nc: 3\n'; // b 的缩进比 a/c 多 1
        const r = checkYamlParseable(yaml);
        expect(r.ok).toBe(false);
    });

    it('重复 key → yaml lib 判定为 error（严格模式）', () => {
        const yaml = 'k: 1\nk: 2\n';
        const r = checkYamlParseable(yaml);
        // yaml lib 默认将重复 key 判为 error，不可解析
        expect(r.ok).toBe(false);
    });
});

describe('端到端：mega 样例文件解析状态', () => {
    const MEGA = path.join(__dirname, '..', '..', 'examples', 'yaml-format-issues-mega.yaml');
    it.runIf(fs.existsSync(MEGA))('原始 mega 文件（含大量语法错误）→ 不可解析', () => {
        const raw = fs.readFileSync(MEGA, 'utf8');
        const r = checkYamlParseable(raw);
        expect(r.ok).toBe(false);
    });

    it.runIf(fs.existsSync(MEGA))('mega 文件在应用完全部 fix 后 → 只残留少量极端非法行', async () => {
        // 复用 validateYamlContent + 多轮迭代 apply 的收敛策略
        const { validateYamlContent, clearYamlValidationCache } = await import('../utils/yamlValidator');
        let current = fs.readFileSync(MEGA, 'utf8');
        for (let round = 0; round < 5; round++) {
            clearYamlValidationCache();
            const issues = validateYamlContent(current);
            const lineToFix = new Map<number, string>();
            for (const iss of issues) {
                if (iss.fix !== undefined) lineToFix.set(iss.line, iss.fix);
            }
            if (lineToFix.size === 0) break;
            const arr = current.split('\n');
            let any = false;
            for (const [ln, fix] of lineToFix) {
                if (ln >= 1 && ln <= arr.length && arr[ln - 1] !== fix) {
                    arr[ln - 1] = fix;
                    any = true;
                }
            }
            current = arr.join('\n');
            if (!any) break;
        }
        const r = checkYamlParseable(current);
        // 深水区兜底注释化（`# [unparseable]`）覆盖了所有无法归类的 parse error，
        // mega 修完后应 100% parse 通过。
        expect(r.ok).toBe(true);
    });
});
