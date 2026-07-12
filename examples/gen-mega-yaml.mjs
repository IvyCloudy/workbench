#!/usr/bin/env node
/**
 * ============================================================================
 * gen-mega-yaml.mjs
 * 生成一个"综合、大规模、可复现"的 YAML 问题样例文件
 * ----------------------------------------------------------------------------
 * 目标：
 *   1. 覆盖插件所有校验规则的边界场景
 *   2. 总问题数 > 2000，确保能触发 fix-all 的分批修复（batchSize=100，>20 批）
 *   3. 覆盖"行末 Tab / 值中 Tab / 值前 Tab"等 Tab 边界场景
 *   4. 覆盖"未闭合引号"导致的 parse error 级联
 *   5. 生成结果稳定可复现（不使用随机）
 * ----------------------------------------------------------------------------
 * 用法：
 *   node examples/gen-mega-yaml.mjs
 *   → 产出：examples/yaml-format-issues-mega.yaml
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, 'yaml-format-issues-mega.yaml');

const lines = [];
const push = (s = '') => lines.push(s);

// ─────────────────────────────────────────────────────────────
// Section 0：BOM + 头部说明
// ─────────────────────────────────────────────────────────────
push('\uFEFF# ============================================================================');
push('# 综合大规模 YAML 问题样例（用于验证分批修复：batchSize=100，>20 批）');
push('# ---------------------------------------------------------------------------');
push('# 目标问题量：> 2000');
push('# 由 examples/gen-mega-yaml.mjs 自动生成，勿手工修改');
push('# ============================================================================');
push('');

// ─────────────────────────────────────────────────────────────
// Section 1：Tab 边界场景（重点新增）
// ─────────────────────────────────────────────────────────────
push('# ---------- Section 1: Tab 相关边界 ----------');
push('tab_cases:');
push('  # 1.1 值末尾一个 Tab —— 触发 R2 且可能干扰下一行结构');
push('  end_tab_1: value1\t');
push('  end_tab_2: value2\t');
push('  end_tab_3: value3\t');
push('  # 1.2 值中间夹 Tab —— R2');
push('  mid_tab_1: hello\tworld');
push('  mid_tab_2: foo\tbar\tbaz');
push('  # 1.3 冒号后紧跟 Tab（等价于缺空格 + 内联 Tab）');
push('  after_colon_tab_1:\tvalue');
push('  after_colon_tab_2:\tanother');
push('  # 1.4 值末连续多个 Tab');
push('  multi_end_tab: end\t\t\t');
push('  # 1.5 Tab 缩进（R1，命中即 stop 其他规则）');
push('\ttab_indent_1: v');
push('\ttab_indent_2: v');
push('\ttab_indent_3: v');
push('');

// ─────────────────────────────────────────────────────────────
// Section 2：BOM / 行末空格 / 冒号缺空格 / 值中 # / 保留字符 …… 精调用例
// ─────────────────────────────────────────────────────────────
push('# ---------- Section 2: 各规则典型示例 ----------');
push('typical:');
push('  name:hello                    # R4 冒号后缺空格');
push('  desc: my #note                # R6 值中 # 会被丢弃');
push('  enabled: yes                  # R5 歧义布尔');
push('  disabled: off                 # R5 歧义布尔');
push('  ratio: NaN                    # R5 特殊数值');
push('  fallback: null                # R5 null');
push('  body: {a:1,b:2}               # R7 { }');
push('  tags: [ci, dev]               # R7 [ ]');
push('  ref_val: a&b                  # R7 &');
push('  ptr_val: a*b                  # R7 *');
push('  bang_val: a!b                 # R7 !');
push('  gt_val: a>b                   # R7 >');
push('  pipe_val: a|b                 # R7 |');
push('  comma_val: a,b,c              # R7 ,');
push('  trailing_ws: hi   ');
push('  ends_with_ws2: bye    ');
push('');
push('list_bad_dash:');
push('  -foo                          # R8');
push('  -bar                          # R8');
push('  -baz                          # R8');
push('  - good');
push('');

// ─────────────────────────────────────────────────────────────
// Section 3：重复 key（同层 / 嵌套 / sequence 内）
// ─────────────────────────────────────────────────────────────
push('# ---------- Section 3: 重复 key ----------');
push('dup_root:');
push('  a: 1');
push('  a: 2                          # F1 dup');
push('  b: 3');
push('  b: 4                          # F1 dup');
push('  b: 5                          # F1 dup');
push('nested_dup:');
push('  inner:');
push('    x: 1');
push('    x: 2                        # F1 dup');
push('    y: 3');
push('    y: 4                        # F1 dup');
push('seq_dup_items:');
push('  - k: 1');
push('    k: 2                        # F1 dup（sequence 同一 item 内）');
push('  - k: 3');
push('    k: 4                        # F1 dup（sequence 同一 item 内）');
push('# 下面这段属于合法：sequence 不同 item 的同名 key，不应报警');
push('seq_ok_items:');
push('  - operation: a');
push('    target: t1');
push('  - operation: b');
push('    target: t2');
push('');

// ─────────────────────────────────────────────────────────────
// Section 4：Parse Error 级联（未闭合引号）
// ─────────────────────────────────────────────────────────────
push('# ---------- Section 4: 未闭合引号 → parse error 级联 ----------');
push('broken_zone:');
push('  bad_string: "this quote never closes and eats the rest');
push('  next_key_1: value_a           # 被上一行吞掉');
push('  next_key_2: value_b           # 级联 error');
push('  nested_layer:');
push('    deep_1: 1');
push('    deep_2: 2');
push('    dup_in_broken: x');
push('    dup_in_broken: y            # F1（若还能识别）');
push('');

// ─────────────────────────────────────────────────────────────
// Section 5：程序化生成的批量问题（用于凑到 2000+）
// ─────────────────────────────────────────────────────────────
push('# ---------- Section 5: 批量生成的问题（用于验证分批修复） ----------');
push('# 结构：mass_group_XXX，每组内塞入 8~10 个典型问题');
push('mass_groups:');

// 每组贡献大约 10 个问题：
//   - R4 冒号缺空格         : 1
//   - R5 歧义布尔           : 1
//   - R5 歧义 null          : 1
//   - R6 值中 #             : 1
//   - R7 保留字符 {}        : 1
//   - R7 保留字符 &         : 1
//   - R3 行末空格           : 1
//   - R2 值末 Tab           : 1
//   - F1 组内重复 key       : 1
//   - R8 序列 - 缺空格      : 1
// → 10 个/组 * 210 组 ≈ 2100 个问题
const GROUP_COUNT = 210;
for (let g = 1; g <= GROUP_COUNT; g++) {
    const gid = String(g).padStart(3, '0');
    push(`  group_${gid}:`);
    push(`    field_${gid}_a:value_${gid}`);           // R4
    push(`    field_${gid}_b: yes`);                    // R5 布尔
    push(`    field_${gid}_c: null`);                   // R5 null
    push(`    field_${gid}_d: label${gid} #tag`);       // R6
    push(`    field_${gid}_e: {k${gid}:1,v:2}`);        // R7 {
    push(`    field_${gid}_f: a&b_${gid}`);             // R7 &
    push(`    field_${gid}_g: trail_${gid}    `);       // R3 行末空格
    push(`    field_${gid}_h: endtab_${gid}\t`);        // R2 值末 Tab
    push(`    field_${gid}_i: 1`);
    push(`    field_${gid}_i: 2`);                      // F1 dup
    push(`    items_${gid}:`);
    push(`      -bad_${gid}`);                          // R8
}
push('');

// ─────────────────────────────────────────────────────────────
// Section 5.5：YAML 保留字段/歧义关键字（全家桶）
// ─────────────────────────────────────────────────────────────
push('# ---------- Section 5.5: 保留字段/歧义关键字全家桶 ----------');
push('# 目标：把 yamlConstants.ts 中 BOOLEAN / NULL / NUMERIC_SPECIAL 集合以及');
push('# RESERVED_CHARS_PATTERN 的每个字符都单独覆盖到，方便回归定位。');
push('reserved_keywords:');
// R5 布尔（BOOLEAN_KEYWORDS 全量）
push('  # R5 布尔关键字全集（未加引号）');
push('  bool_true_lower: true');
push('  bool_false_lower: false');
push('  bool_true_upper: TRUE');
push('  bool_false_upper: FALSE');
push('  bool_true_cap: True');
push('  bool_false_cap: False');
push('  bool_yes_lower: yes');
push('  bool_no_lower: no');
push('  bool_yes_upper: YES');
push('  bool_no_upper: NO');
push('  bool_yes_cap: Yes');
push('  bool_no_cap: No');
push('  bool_on_lower: on');
push('  bool_off_lower: off');
push('  bool_on_upper: ON');
push('  bool_off_upper: OFF');
push('  bool_on_cap: On');
push('  bool_off_cap: Off');
// R5 null（NULL_KEYWORDS 全量）
push('  # R5 null 关键字全集');
push('  null_lower: null');
push('  null_upper: NULL');
push('  null_cap: Null');
push('  null_tilde: ~');
// R5 特殊数值（NUMERIC_SPECIAL_KEYWORDS 全量）
push('  # R5 特殊数值全集');
push('  num_inf_lower: .inf');
push('  num_nan_lower: .nan');
push('  num_inf_upper: .INF');
push('  num_nan_upper: .NAN');
push('  num_infinity: Infinity');
push('  num_neg_infinity: -Infinity');
push('');
push('reserved_chars:');
push('  # R7 每个保留字符单独示例');
push('  bracket_open: a[b');
push('  bracket_close: a]b');
push('  brace_open: a{b');
push('  brace_close: a}b');
push('  comma_only: a,b,c,d');
push('  anchor_amp: value&anchor');
push('  alias_star: value*ref');
push('  tag_bang: value!type');
push('  fold_gt: value>next');
push('  literal_pipe: value|next');
push('  # 保留字符组合：同时命中多规则');
push('  mixed_1: {a:1,b:[c,d]}                    # R7 { [ , }');
push('  mixed_2: !tag &anchor *alias >fold |lit    # R7 ! & * > |');
push('');

// ─────────────────────────────────────────────────────────────
// Section 5.6：特殊结构（内嵌 JSON / 复杂 flow / 块标量）
// ─────────────────────────────────────────────────────────────
push('# ---------- Section 5.6: 特殊结构 / 内嵌 JSON ----------');
push('# 目标：验证插件对"合法但危险"的写法能否给出正确诊断/修复');
push('# 注意：本章节所有"有问题"用例都必须能通过 R5/R6/R7 兜底修复，');
push('# 不能引入无法收敛的 parse error（会破坏 mega-batch 收敛断言）。');
push('json_inline:');
// 未加引号的内嵌 JSON（触发 R7 { [ , 组合，可通过加引号修复）
push('  # 单行 JSON 对象作值（未加引号 → R7 { , }）');
push('  jo_simple: {"name":"tom","age":18}');
push('  jo_bool: {"enabled":true,"count":10}');
push('  jo_nested: {"user":{"id":1,"tags":["a","b"]},"active":true}');
push('  jo_array: [1,2,3,{"k":"v"}]');
push('  # 值内既是 JSON 又含 # → R6 + R7 组合');
push('  jo_with_hash: {"note":"a tag inside"} extra #comment');
push('  # JSON 字符串中含冒号 → R7 { 命中');
push('  jo_with_colon: {"url":"https://a.com/x?y=1"}');
push('  # JSON 数组含 URL/特殊字符');
push('  ja_urls: ["https://a.com","https://b.com?q=1&r=2"]');
push('  # 已用引号包裹的 JSON（合法示例，不应命中 R7）');
push('  jo_quoted_ok: \'{"name":"tom","age":18}\'');
push('  ja_quoted_ok: "[1,2,3]"');
push('');
push('flow_edge:');
push('  # 嵌套 flow（合法 —— 不应误报）');
push('  deep_flow_ok: \'{"a":{"b":{"c":{"d":1}}}}\'');
push('  # flow 里带保留字符（未引号 → R7 命中）');
push('  flow_reserved: {tag:type, ref:anchor, ptr:alias}');
push('');
push('block_scalars:');
push('  # 块标量头本身合法，内容里的 # 在 block scalar 中不会被视为注释');
push('  literal_ok: |');
push('    line-1');
push('    line-2 has #hash but ok in block scalar');
push('  folded_ok: >');
push('    this is a folded block');
push('    #hash also ok here');
push('  # 带修饰符的块标量');
push('  literal_strip: |-');
push('    strip-trailing-newline');
push('  folded_keep: >+');
push('    keep-trailing-newline');
push('');
push('anchor_alias_ok:');
push('  # 锚点与别名（合法用法 —— 不应误报）');
push('  base: &base_1');
push('    host: example.com');
push('    port: 443');
push('  derived: *base_1');
push('');
push('yaml_tags_ok:');
push('  # YAML 内置标签（!!str / !!int / !!bool —— yaml lib 可识别）');
push('  as_str: !!str 12345');
push('  as_int: !!int "42"');
push('  as_bool: !!bool "true"');
push('');
push('multiline_strings_ok:');
push('  # 折叠 / 保留换行（合法）');
push('  desc_folded: >-');
push('    This is a long description');
push('    that folds into a single line.');
push('  desc_literal: |-');
push('    line-A');
push('    line-B');
push('');
push('embedded_scripts:');
push('  # 脚本片段作值（含大量保留字符、# 等 —— 建议加引号，规则可自动修复）');
push('  bash_cmd: if [ -z X ]; then echo empty; fi');
push('  js_expr: const arr = [1,2,3]; arr.map(x => x*2);');
push('  regex_val: pattern &value *ref !type');
push('  json_pointer: /users/0/name');
push('');

// ─────────────────────────────────────────────────────────────
// Section 6：末尾守卫（几行完全合法的内容，验证前面级联不影响这里）
// ─────────────────────────────────────────────────────────────
push('# ---------- Section 6: 尾部合法内容（不应被误报） ----------');
push('trailing_ok:');
push('  quoted_yes: "yes"');
push('  quoted_brace: "{a:1}"');
push('  quoted_hash: "value #with hash"');
push('  numeric_ok: 12345');
push('  ip_ok: "192.168.1.1"');
push('  url_ok: "https://example.com/path?a=1&b=2"');
push('');
push('# EOF');

const content = lines.join('\n');
fs.writeFileSync(OUT_PATH, content, 'utf8');

// 简单统计
const totalLines = lines.length;
const sizeKB = (Buffer.byteLength(content, 'utf8') / 1024).toFixed(2);
console.log(`✅ 已生成: ${OUT_PATH}`);
console.log(`   行数: ${totalLines}, 大小: ${sizeKB} KB`);
console.log(`   预期问题数量: ~${GROUP_COUNT * 10 + 60} 处（>2000，可覆盖 >20 批）`);
