# YAML 校验测试样例（按场景分开）

本目录用于**按单一规则/场景**验证 YAML 校验器的每一条规则、修复策略与"防误报"边界。相比 `examples/yaml-format-issues-showcase.yaml`（综合样例）和 `examples/yaml-format-issues-mega.yaml`（大文件回归），这里的文件**每个只聚焦一个测试点**，方便逐条勾选、复现与分工。

## 文件索引

| 文件 | 覆盖规则 | 期望命中数 | 期望现象 |
|---|---|---|---|
| `01-tab-indent.yaml` | R1 Tab 缩进（stopOnHit, error） | Tab 缩进 ≥ 5 | 命中即停，不叠加其它规则 |
| `02-inline-tab.yaml` | R2 值中 Tab（warning） | 含 Tab 字符 ≥ 4 | Tab → 空格 |
| `03-trailing-space.yaml` | R3 行末空格 | 行末多余空格 ≥ 7 | 删除行尾空白 |
| `04-colon-space.yaml` | R4 冒号缺空格 | 缺少空格 ≥ 5 | `key:value` → `key: value`；URL/时间戳不误报 |
| `05-dash-space.yaml` | R8 短横线缺空格 | 缺少空格 ≥ 5 | `-value` → `- value`；负数/减号不误报 |
| `06-ambiguous-value.yaml` | R5 歧义布尔/null/inf/NaN | 需引号 ≥ 10 | 加双引号；已加引号不误报 |
| `07-hash-in-value.yaml` | R6 值中 # | 值中 # 会被丢弃 ≥ 4 | 加引号；紧贴 `#`（无空格）不误报 |
| `08-reserved-chars.yaml` | R7 保留字符 `{ } [ ] & * ! > \| ,` | 保留字符 ≥ 12 | 加引号；引号内不误报 |
| `09-duplicate-keys.yaml` | F1 重复 key | 重复的 key ≥ 5 | 后者注释化；sequence 不同 item 同名 key 不误报 |
| `10-parse-cascade.yaml` | Parse 级联 | 至少 1 条 parse error | 修好未闭引号后级联 error 自动消失 |
| `11-quoted-ok.yaml` | ✅ 合法样例 | **必须 = 0** | 防误报回归 |
| `12-range-fix.yaml` | 多行选中修复 | 可修问题 ≥ 12 | A/B/C 三段问题簇，选段验证"修复选中范围"入口 |

## 使用建议

- **手动分场景验证**：逐个打开对应文件，观察左侧标尺 diagnostic 和 Quick Fix 菜单。
- **多行选中修复**：打开 `12-range-fix.yaml`，选中 B 段（`segment_b:` 到 `ratio: NaN` 结束的整段），触发 Quick Fix（`⌘.` / 灯泡），应看到
  `🔧 修复选中范围（第 X~Y 行，共 N 处）`；点击后只修 B 段。
- **防误报回归**：`11-quoted-ok.yaml` 打开后应无任何红/黄波浪线；一旦规则改动出现新的 diagnostic，说明引入了误报。
- **自动化回归**：`src/test/yaml-scenarios.regression.test.ts` 已把上表的期望值固化为断言，运行 `npx vitest run yaml-scenarios.regression` 可一键检查。
- **综合场景**：仍保留 `../yaml-format-issues-showcase.yaml`（所有规则叠加）与 `../yaml-format-issues-mega.yaml`（大文件 2000+ 问题）作为回归基线。

## 特别说明

- **不要在测试样例的行末加 `# xxx` 备注**：当前 R6（"值中 # 会被丢弃"）会把 `key: value  # 备注` 里的 `# 备注` 视为值的一部分并报警，从而污染场景。所有说明性注释均放在被观察行的**上一行**（独立注释）。
- **布尔字面量 `true` / `false`**：当前规则把它们纳入"歧义布尔"，故在"合法样例"里也必须用引号形式 `"true"` / `"false"`。
