/**
 * ============================================================================
 *  test/yaml-validator.test.ts
 *  YAML 校验规则回归测试
 * ----------------------------------------------------------------------------
 *  覆盖：
 *    R1 Tab 缩进 / R2 内联 Tab / R3 行末空格 / R4 冒号后空格
 *    R5 布尔/null/数值歧义值 / R6 值中 # / R7 保留字符
 *    R8 序列 - 后缺空格 / F1 重复 key
 *    BOM 头 / 缓存快速路径
 *  说明：为避免在测试环境加载 vscode，本用例只 import 纯逻辑模块。
 * ============================================================================
 */
import { describe, it, expect } from 'vitest';
import {
    validateYamlContent,
    clearYamlValidationCache,
} from '../utils/yamlValidator';

/** 找到指定 title 的第一条 issue */
function findByTitle(issues: ReturnType<typeof validateYamlContent>, kw: string) {
    return issues.find(i => (i.title ?? '').includes(kw) || i.message.includes(kw));
}

describe('YAML 校验规则', () => {
    it('R1 Tab 缩进：命中并给出替换 fix', () => {
        const src = '\tkey: value\n';
        const issues = validateYamlContent(src);
        const iss = findByTitle(issues, 'Tab 缩进');
        expect(iss).toBeDefined();
        expect(iss?.severity).toBe('error');
        expect(iss?.fix).toBe('  key: value');
    });

    it('R3 行末空格：命中并 trim', () => {
        const src = 'name: hello   \n';
        const issues = validateYamlContent(src);
        const iss = findByTitle(issues, '行末');
        expect(iss).toBeDefined();
        expect(iss?.fix).toBe('name: hello');
    });

    it('R2 行末仅有 Tab：不重复报 R2，交由 R3 独占处理', () => {
        clearYamlValidationCache();
        const src = 'name: hello\t\n';
        const issues = validateYamlContent(src);
        // R2 不应命中
        expect(findByTitle(issues, '含 Tab 字符')).toBeUndefined();
        // R3 应命中并 trim 掉尾部 Tab
        const trailing = findByTitle(issues, '行末');
        expect(trailing).toBeDefined();
        expect(trailing?.fix).toBe('name: hello');
    });

    it('R2 中间 Tab + 行末 Tab：R2 只报中间那个（不含行末 Tab）', () => {
        clearYamlValidationCache();
        const src = 'name:\thello\t\n';
        const issues = validateYamlContent(src);
        const r2 = findByTitle(issues, '含 Tab 字符');
        expect(r2).toBeDefined();
        // 中间 Tab 位于第 6 列
        expect(r2?.column).toBe(6);
        // R3 独立命中
        expect(findByTitle(issues, '行末')).toBeDefined();
    });

    it('R2 纯中间 Tab：正常报 R2，不受优化影响', () => {
        clearYamlValidationCache();
        const src = 'name:\thello\n';
        const issues = validateYamlContent(src);
        const r2 = findByTitle(issues, '含 Tab 字符');
        expect(r2).toBeDefined();
        expect(r2?.fix).toBe('name: hello');
    });

    it('R2/R4 去重：冒号后紧跟 Tab（key:\\tvalue） → 只报 R2，不重复报 R4', () => {
        clearYamlValidationCache();
        const src = 'after_colon_tab_1:\tvalue\n';
        const issues = validateYamlContent(src);
        // R2 应命中且提供 fix
        const r2 = findByTitle(issues, '含 Tab 字符');
        expect(r2).toBeDefined();
        expect(r2?.fix).toBe('after_colon_tab_1: value');
        // R4 应静默（交由 R2 独占）
        const r4 = issues.find(i => (i.title ?? '') === '缺少空格' && i.message.includes('冒号'));
        expect(r4).toBeUndefined();
    });

    it('R5/R6 去重：k: yes #note → 只报 R6，fix 保留注释文本', () => {
        clearYamlValidationCache();
        const src = 'k: yes #note\n';
        const issues = validateYamlContent(src);
        const r6 = findByTitle(issues, '# 会被丢弃');
        expect(r6).toBeDefined();
        expect(r6?.fix).toBe('k: "yes #note"');
        // R5 应静默（让位 R6）
        const r5 = issues.find(i => (i.title ?? '').includes('需引号'));
        expect(r5).toBeUndefined();
    });

    it('R6 豁免：k: {a} #note → R6/R7 都静默（值为合法 flow map + 合法行内注释）', () => {
        clearYamlValidationCache();
        const src = 'k: {a} #note\n';
        const issues = validateYamlContent(src);
        // 值 `{a}` 是合法 flow map，#note 是合法行内注释，
        // 包引号反而破坏语义，因此 R6 应豁免。
        const r6 = issues.find(i => (i.title ?? '').includes('# 会被丢弃'));
        expect(r6).toBeUndefined();
        // R7 也应静默（与 R7 新增豁免一致）
        const r7 = issues.find(i => (i.title ?? '').includes('保留字符'));
        expect(r7).toBeUndefined();
    });

    it('R6 仍报：普通值 + #note 需报 R6（保留原有主线行为）', () => {
        clearYamlValidationCache();
        const src = 'k: hello #note\n';
        const issues = validateYamlContent(src);
        const r6 = findByTitle(issues, '# 会被丢弃');
        // 普通值 `hello` 不是 YAML 指示符，R6 仍应报并提供“整段包引号” fix
        expect(r6).toBeDefined();
        expect(r6?.fix).toBe('k: "hello #note"');
    });

    it('R4/R5 联合 fix：k:yes → 只报 R5，fix 一步到位（补空格+引号）', () => {
        clearYamlValidationCache();
        const src = 'k:yes\n';
        const issues = validateYamlContent(src);
        const r5 = findByTitle(issues, '需引号');
        expect(r5).toBeDefined();
        expect(r5?.fix).toBe('k: "yes"');
        // R4 应静默（值本身歧义，让位 R5）
        const r4 = issues.find(i => (i.title ?? '') === '缺少空格' && i.message.includes('冒号'));
        expect(r4).toBeUndefined();
    });

    it('R4/R7 联合：k:{a} → 只报 R4（值为合法 flow map，R7 豁免）', () => {
        clearYamlValidationCache();
        const src = 'k:{a}\n';
        const issues = validateYamlContent(src);
        // 值 `{a}` 是合法 flow map，R7 应静默（豁免）
        const r7 = issues.find(i => (i.title ?? '').includes('保留字符'));
        expect(r7).toBeUndefined();
        // R4 应报“冒号后缺空格”
        const r4 = findByTitle(issues, '缺少空格');
        expect(r4).toBeDefined();
        expect(r4?.fix).toBe('k: {a}');
    });

    it('R4 冒号后缺空格：命中并补空格', () => {
        const src = 'name:hello\n';
        const issues = validateYamlContent(src);
        const iss = findByTitle(issues, '缺少空格');
        expect(iss).toBeDefined();
        expect(iss?.fix).toBe('name: hello');
    });

    it('R5 歧义关键字 yes → 引号包裹', () => {
        const src = 'enabled: yes\n';
        const issues = validateYamlContent(src);
        const iss = findByTitle(issues, '布尔值');
        expect(iss).toBeDefined();
        expect(iss?.fix).toBe('enabled: "yes"');
    });

    it('R5 歧义关键字 null 分类正确', () => {
        const src = 'x: null\n';
        const issues = validateYamlContent(src);
        const iss = findByTitle(issues, '空值 null');
        expect(iss).toBeDefined();
    });

    it('R5 已加引号的值不再报警', () => {
        const src = 'enabled: "yes"\n';
        const issues = validateYamlContent(src);
        expect(findByTitle(issues, '布尔值')).toBeUndefined();
    });

    it('R6 值中 # 空格前触发注释解析', () => {
        const src = 'title: my #special\n';
        const issues = validateYamlContent(src);
        const iss = findByTitle(issues, '会被丢弃');
        expect(iss).toBeDefined();
        expect(iss?.fix).toContain('"my #special"');
    });

    it('R6 豁免：对齐尾注释（值和 # 之间 >=2 空格）不应触发 R6', () => {
        clearYamlValidationCache();
        // `enabled: yes                  # 注释` 是合法对齐尾注释，R6 应豁免
        const issues1 = validateYamlContent('enabled: yes                  # R5 歧义布尔\n');
        expect(findByTitle(issues1, '会被丢弃')).toBeUndefined();
        // 但 R5 仍应触发（歧义值需引号）
        expect(findByTitle(issues1, '布尔值')).toBeDefined();

        // `name: hello                    # 说明` 值为合法字符串，R6 应豁免（且无 R5/R7）
        const issues2 = validateYamlContent('name: hello                    # 只是说明\n');
        expect(findByTitle(issues2, '会被丢弃')).toBeUndefined();

        // 保留紧贴场景：`desc: my #note` 只有 1 空格，R6 应仍触发
        const issues3 = validateYamlContent('desc: my #note\n');
        expect(findByTitle(issues3, '会被丢弃')).toBeDefined();
    });

    it('R6 fix：紧贴 #note 后有合法对齐尾注释时，只包裹到 #note 段结束', () => {
        clearYamlValidationCache();
        // 值 `my` + 紧贴 `#note`（gap=1，要保护）+ 大空格 + 合法尾注释 → 只包裹 `my #note`
        const src = 'desc: my #note                # 真正注释\n';
        const issues = validateYamlContent(src);
        const iss = findByTitle(issues, '会被丢弃');
        expect(iss).toBeDefined();
        expect(iss?.fix).toBe('desc: "my #note"                # 真正注释');
    });

    it('R7 豁免：合法 flow map/flow seq 不应报保留字符', () => {
        clearYamlValidationCache();
        // `body: {a:1}` 是合法 YAML flow mapping，R7 应豁免
        const issues1 = validateYamlContent('body: {a:1}\n');
        expect(findByTitle(issues1, '保留字符')).toBeUndefined();
        // `k: []` 是合法 flow sequence，R7 应豁免
        const issues2 = validateYamlContent('k: []\n');
        expect(findByTitle(issues2, '保留字符')).toBeUndefined();
        // `k: {}` 是合法 flow mapping，R7 应豁免
        const issues3 = validateYamlContent('k: {}\n');
        expect(findByTitle(issues3, '保留字符')).toBeUndefined();
        // `k: |` 是合法块标量头，R7 应豁免（下一行为内容，不报错）
        const issues4 = validateYamlContent('k: |\n  hello\n');
        expect(findByTitle(issues4, '保留字符')).toBeUndefined();
        // `k: *anchor` 是合法别名引用，R7 应豁免（尽管 anchor 未定义会被 yaml 库报 error，
        //   但属于解析阶段，不影响 R7 额外报字符串化）
        const issues5 = validateYamlContent('a: 1\nk: *anchor\n'); // 无 anchor 定义时 yaml 库会报 error，但 R7 仍应静默
        const r7Issue5 = issues5.find(i => (i.title ?? '').includes('保留字符'));
        expect(r7Issue5).toBeUndefined();
        // 反例：未闭合的 flow 集合应仍报 R7
        const issues6 = validateYamlContent('k: [unclosed\n');
        // 未闭合 → 不命中 flow_seq 豁免正则 → R7 仍会报（除非被 R6 等抢先，本 case 无行内注释）
        expect(findByTitle(issues6, '保留字符')).toBeDefined();
    });

    it('R8 序列 - 后缺空格', () => {
        const src = '-foo\n-bar\n';
        const issues = validateYamlContent(src);
        const targets = issues.filter(i => (i.title ?? '') === '缺少空格');
        // 应该 2 行都命中
        expect(targets.length).toBeGreaterThanOrEqual(2);
        expect(targets[0].fix).toBe('- foo');
        expect(targets[1].fix).toBe('- bar');
    });

    it('F1 重复 key 检测', () => {
        const src = 'a: 1\nb: 2\na: 3\n';
        const issues = validateYamlContent(src);
        const iss = findByTitle(issues, '重复的 key');
        expect(iss).toBeDefined();
        expect(iss?.line).toBe(3);
        expect(iss?.message).toContain('第 1 行');
    });

    it('F1 重复 key 提供 fix（把重复行注释化）', () => {
        clearYamlValidationCache();
        const src = 'a: 1\nb: 2\na: 3\n';
        const issues = validateYamlContent(src);
        const iss = findByTitle(issues, '重复的 key');
        expect(iss).toBeDefined();
        expect(iss?.fix).toBeDefined();
        expect(iss?.fix).toBe('# [duplicate key removed] a: 3');
    });

    it('F1 缩进重复 key 的 fix 保留原缩进', () => {
        clearYamlValidationCache();
        const src = 'metadata:\n  version: 1\n  version: 2\n';
        const issues = validateYamlContent(src);
        const iss = findByTitle(issues, '重复的 key');
        expect(iss?.fix).toBe('  # [duplicate key removed] version: 2');
    });

    it('F1 不同作用域的同名 key 不算重复', () => {
        const src = 'outer:\n  a: 1\nother:\n  a: 2\n';
        const issues = validateYamlContent(src);
        expect(findByTitle(issues, '重复的 key')).toBeUndefined();
    });

    it('F1 sequence 不同 item 的同名 key 不算重复（缩进写法）', () => {
        const src =
            'steps:\n' +
            '  - operation: click\n' +
            '    target: btn1\n' +
            '  - operation: input\n' +
            '    target: input1\n';
        const issues = validateYamlContent(src);
        expect(findByTitle(issues, '重复的 key')).toBeUndefined();
    });

    it('F1 sequence 不同 item 的同名 key 不算重复（紧凑写法）', () => {
        const src =
            'steps:\n' +
            '- operation: click\n' +
            '  target: btn1\n' +
            '- operation: input\n' +
            '  target: input1\n';
        const issues = validateYamlContent(src);
        expect(findByTitle(issues, '重复的 key')).toBeUndefined();
    });

    it('F1 sequence 同一 item 内真正重复 → 命中', () => {
        const src =
            'steps:\n' +
            '  - operation: click\n' +
            '    operation: input\n';
        const issues = validateYamlContent(src);
        const iss = findByTitle(issues, '重复的 key');
        expect(iss).toBeDefined();
        expect(iss?.line).toBe(3);
    });

    it('F1 sequence 嵌套结构下不同 item 的同名深层 key 不误报', () => {
        const src =
            'steps:\n' +
            '  - operation: click\n' +
            '    params:\n' +
            '      x: 1\n' +
            '      y: 2\n' +
            '  - operation: input\n' +
            '    params:\n' +
            '      x: 3\n' +
            '      y: 4\n';
        const issues = validateYamlContent(src);
        expect(findByTitle(issues, '重复的 key')).toBeUndefined();
    });

    it('BOM 头检测', () => {
        const src = '\uFEFFname: hi\n';
        const issues = validateYamlContent(src);
        expect(findByTitle(issues, 'BOM')).toBeDefined();
    });

    it('findYamlColon 跳过引号内冒号：不误报冒号缺空格', () => {
        const src = 'title: "hello: world"\n';
        const issues = validateYamlContent(src);
        // 引号内的 : 不应被识别为 kv 分隔冒号，第一个冒号后已有空格，因此不该报警
        expect(findByTitle(issues, '缺少空格')).toBeUndefined();
    });

    it('注释行不参与检查', () => {
        const src = '# a:b\n# just: comment\n';
        const issues = validateYamlContent(src);
        expect(issues.filter(i => i.severity !== 'error')).toHaveLength(0);
    });

    it('内容缓存快速路径：两次校验返回同一数组引用', () => {
        clearYamlValidationCache();
        const src = 'name: hi\n';
        const a = validateYamlContent(src);
        const b = validateYamlContent(src);
        expect(a).toBe(b);
    });

    it('同一行多规则命中：行末空格 + 冒号缺空格 共存', () => {
        // 冒号后无空格 + 行末空格
        const src = 'k:v   \n';
        const issues = validateYamlContent(src);
        expect(findByTitle(issues, '缺少空格')).toBeDefined();
        expect(findByTitle(issues, '行末')).toBeDefined();
    });

    it('值等价过滤：已合法的值不产生 issue（fix===原行 时丢弃）', () => {
        clearYamlValidationCache();
        // 已经加双引号的布尔值 -> R5 不应命中
        const src1 = 'enabled: "yes"\n';
        expect(validateYamlContent(src1).filter(i => i.severity !== 'error')).toHaveLength(0);
        clearYamlValidationCache();
        // 已加单引号的保留字符 -> R7 不应命中
        const src2 = "body: '{a:1}'\n";
        expect(validateYamlContent(src2).filter(i => i.severity !== 'error')).toHaveLength(0);
        clearYamlValidationCache();
        // 完全正常的一行 -> 零 issue
        const src3 = 'name: hello\nage: 18\n';
        expect(validateYamlContent(src3)).toHaveLength(0);
    });

    it('parser 兜底让位：同一行已有规则 fix 时，parser 错误不再叠加 "# [indent mismatch]" 破坏性 fix', () => {
        clearYamlValidationCache();
        // 构造：`name:hello` (R4) 会让 yaml lib 对后续行报 "same column" parse error
        // 期望：同行 R4 的 fix 保留（`name: hello ...`），parser error 只报错不给破坏性 fix
        const src = [
            'root:',
            '  name:hello                    # R4 冒号后缺空格',  // R4 命中，同时可能触发 parse error
            '  desc: my #note                # R6 值中 # 会被丢弃',
            '  enabled: yes                  # R5 歧义布尔',
            '',
        ].join('\n');
        const issues = validateYamlContent(src);

        // 找 R4 修复（第 2 行）
        const r4 = issues.find(i => i.line === 2 && (i.title === '冒号缺空格' || i.message.includes('冒号')));
        expect(r4).toBeDefined();
        expect(r4?.fix).toBeDefined();
        expect(r4?.fix?.trimStart().startsWith('# [indent mismatch]')).toBe(false);
        expect(r4?.fix).toContain('name: hello');

        // 若 parser 对第 2 行也报错，其 fix 应为 undefined（被让位规则）；
        // 不应该出现同一行既有 R4 fix 又有 "# [indent mismatch]" 破坏性 fix
        const destructiveSameLine = issues.filter(
            i => i.line === 2 && i.fix !== undefined && i.fix.trimStart().startsWith('# [indent mismatch]'),
        );
        expect(destructiveSameLine).toHaveLength(0);
    });

    // ------------------------------------------------------------------
    // findYamlColon: URL 协议 :// 判定回归（第 9 轮检视 ρ 修复）
    // ------------------------------------------------------------------
    //  历史实现有 `line.substring(i - 2, i) === 'ht'` 的死代码分支，简化后
    //  仅靠 `://` 判定 —— 需保证：
    //   1) http / https / ftp / 自定义协议  → 全部正确跳过
    //   2) 不再依赖 'ht' 前缀假设（例如 `scheme://` 也要能识别）
    //   3) `key: http://xxx` 场景下第一个 `:` 仍能被正确定位为分隔冒号
    // ------------------------------------------------------------------
    describe('findYamlColon URL 场景', () => {
        it('key: http://xxx —— 正确识别 key 后第一个冒号，且不误报 R4', () => {
            clearYamlValidationCache();
            const src = 'homepage: http://example.com/path\n';
            const issues = validateYamlContent(src);
            // 第一个 `:` 后已有空格，R4 不应命中
            expect(findByTitle(issues, '冒号')).toBeUndefined();
        });

        it('https/ftp/自定义协议 —— 内联 :// 不应触发任何 kv 相关规则', () => {
            clearYamlValidationCache();
            const src =
                'a: https://a.com\n' +
                'b: ftp://b.com\n' +
                'c: git://c.com/repo\n' +
                'd: customscheme://payload\n';
            const issues = validateYamlContent(src);
            // 任何一行的 URL 部分都不应被误识为 kv 冒号缺空格
            expect(findByTitle(issues, '冒号')).toBeUndefined();
        });

        it('非 http 前缀的协议（关键：证明不再依赖 ht 前缀）', () => {
            clearYamlValidationCache();
            // hello://world 这种奇怪但合法的字符串，简化后的实现应仍能识别 ://
            const src = 'weird: hello://world\n';
            const issues = validateYamlContent(src);
            expect(findByTitle(issues, '冒号')).toBeUndefined();
        });

        it('http://xxx 出现在值内且无 key 冒号 —— 不误报', () => {
            clearYamlValidationCache();
            // 顶层出现单独的 URL 字面量（不是 kv 结构）应该被 parser 处理，不应触发 R4
            // 这里用 - 序列元素承载 URL 字面量做测试
            const src = '- http://example.com\n- ftp://foo\n';
            const issues = validateYamlContent(src);
            expect(findByTitle(issues, '冒号')).toBeUndefined();
        });

        it('引号内的 URL —— 双重保护：引号跳过 + :// 跳过', () => {
            clearYamlValidationCache();
            const src = 'link: "http://example.com/a:b"\n';
            const issues = validateYamlContent(src);
            expect(findByTitle(issues, '冒号')).toBeUndefined();
        });
    });
});
