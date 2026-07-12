---
name: skill-guardian
description: >-
  一键为任意 skill 项目加上四层版权保护 —— (1) License 头注入、(2) manifest.json
  完整性清单生成 + 运行时校验代码注入、(3) 水印函数注入（作者/版本/机器指纹）、
  (4) 可选的 JavaScript 混淆（javascript-obfuscator）与 Python 混淆（pyarmor）。Copyright 信息全部可配置，
  也提供默认值。触发词：加水印、加版权、License 保护、防复制、防篡改、混淆、pyarmor、
  生成 manifest、加固 skill、protect skill、harden skill。
version: 1.0.0
author: myronliu / Tencent Cloud Big Data
license: Proprietary Internal-Use License
---

# skill-guardian — Skill 版权保护一键加固工具

## 目标

给任意一个「Skill 项目」（结构类似 `skills/xxx/`，含 `SKILL.md` / `scripts/*.js` / `manifest.json`）
一键加上四层保护：

| 层级 | 作用 | 强度 |
|---|---|---|
| ① **License 头** | 每个源码文件顶部注入 Copyright + License 声明 | 声明性、震慑性 |
| ② **manifest.json** | SHA256 清单 + 运行时逐文件校验，篡改则告警/退出 | 强 —— 挡篡改 |
| ③ **水印** | 运行时打印 `作者 · 版本 · 机器指纹`，泄漏可溯源 | 强 —— 挡泄漏 |
| ④ **混淆**（可选） | JS 用 `javascript-obfuscator`；Python 用 `pyarmor`（商业） | 强 —— 挡逆向/抄袭 |

## 触发条件（HARD RULE）

**只要**用户提到下列任意一项，**必须**优先调用本 skill 的脚本，而不是让 LLM 自己拼代码：

- "帮我给 XX skill 加版权/License/水印/防复制/防篡改"
- "生成 manifest / 生成完整性清单"
- "加固这个 skill / harden / protect"
- "把脚本混淆一下 / obfuscate"
- "用 pyarmor 加密 py 脚本 / 把 Python 混淆 / 保护 python 代码"

## 使用方式

### 一键加固（推荐）

```bash
node skills/skill-guardian/scripts/guardian.js [guard] <target-skill-dir> \
    [--author "张三"] \
    [--org "Tencent Cloud Big Data"] \
    [--year 2026] \
    [--license "Proprietary Internal-Use License"] \
    [--jurisdiction "the People's Republic of China"] \
    [--skill-name "yaml-format-fix"] \
    [--version 1.0.0] \
    [--obfuscate]           # 可选：额外产出混淆后的 .min.js（safe 档）
    [--obfuscate-strict]    # 可选：混淆采用 strict 档（激进配置，预定义含 --obfuscate）
    [--obfuscate-python]    # 可选：用 pyarmor 加密 scripts/*.py → scripts/dist_pyarmor/
    [--pyarmor-args "…"]    # 可选：透传给 pyarmor gen（如 "--restrict --expired 2027-01-01"）
    [--refresh]             # 可选：刷新旧的 License 头 / 守卫块（改作者/年份/版本后重跑）
    [--dry-run]             # 仅预览不改文件
    [-v|--verbose|-q|--quiet|--json]  # 日志级别开关
```

### 子命令

| 子命令 | 作用 | 退出码 |
|---|---|---|
| `guard`（默认，可省略） | 执行完整加固流程 | `0` 成功 |
| `verify` | 离线重算 SHA256 并与 `manifest.json` 对比 | `0` 通过 / `97` 篡改 |
| `unguard` | 剥离 License 头 + 运行时守卫块（回滚） | `0` |

```bash
# 加固
node skills/skill-guardian/scripts/guardian.js       skills/my-skill
# 离线校验（不改文件）
node skills/skill-guardian/scripts/guardian.js verify  skills/my-skill
# 卸载守卫（保留 LICENSE / manifest.json）
node skills/skill-guardian/scripts/guardian.js unguard skills/my-skill
```

**所有参数均可省略**，缺省时使用默认值（见下文）；也可以通过项目根的 `.guardianrc.json` 集中配置。

### 参数默认值

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--author` | `myronliu` | 版权归属人 |
| `--org` | `Tencent Cloud Big Data` | 组织/团队名 |
| `--year` | 当前年份 | Copyright 年份 |
| `--license` | `Proprietary Internal-Use License` | License 名称，写进头部注释 |
| `--jurisdiction` | `the People's Republic of China` | LICENSE 里的适用法域文字 |
| `--skill-name` | 目标目录名 | 用于 manifest.name / 水印显示 |
| `--version` | 读取目标 `SKILL.md` 的 `version:` 字段，否则 `1.0.0` | manifest.version |
| `--obfuscate` | `false` | 是否额外生成 `*.min.js` 混淆版（默认 safe 档） |
| `--obfuscate-strict` | `false` | 混淆采用 strict 档（启用 controlFlowFlattening / selfDefending，隐含 `--obfuscate`） |
| `--obfuscate-python` | `false` | 使用 pyarmor 加密 `scripts/*.py`，产物到 `scripts/dist_pyarmor/`（需预装 pyarmor） |
| `--pyarmor-args "…"` | *(空)* | 透传给 `pyarmor gen` 的高级参数 |
| `--refresh` | `false` | 是否刷新已存在的 License 头/守卫块（改元信息后重跑） |

### 配置文件（可选）

在目标 skill 根目录放 `.guardianrc.json`，命令行参数会**覆盖**它：

```json
{
  "author": "myronliu",
  "org": "Tencent Cloud Big Data",
  "year": 2026,
  "license": "Proprietary Internal-Use License",
  "jurisdiction": "the People's Republic of China",
  "skillName": "my-skill",
  "version": "1.0.0",
  "obfuscate": false,
  "obfuscatePython": false,
  "pyarmorArgs": "",
  "protectedFiles": [
    "SKILL.md",
    "README.md",
    "LICENSE",
    "scripts/**/*.js",
    "scripts/**/*.py",
    "references/"
  ]
}
```

> `protectedFiles` 支持三种写法：
> ① **精确相对路径**（如 `SKILL.md`）；
> ② **目录路径**（末尾加 `/`，或写目录名，如 `references/`）—— 递归吸收目录下所有文件；
> ③ **glob 通配**（支持 `*` / `?` / `**` / `[abc]`，如 `scripts/**/*.js`）。
> 若不提供 `protectedFiles`，则默认自动扫描 `.md/.js/.ts/.mjs/.cjs/.py/.txt/.json` 及 `LICENSE`（排除 `manifest.json` / `.guardianrc.json` / `.guardianignore`）。

### `.guardianignore`（可选）

在目标 skill 根目录放 `.guardianignore`，语法**接近 `.gitignore`**：一行一条、`#` 注释、
支持精确路径 / 目录（末尾 `/`）/ 简易 glob。默认已硬编码排除 `node_modules/.git/dist/`
`dist_pyarmor/__pycache__/.venv/…`，这里只需追加项目特有排除项，例如：

```gitignore
*.min.js
*.min.js.map
tmp/
*.log
.DS_Store
```

## 脚本的确定性行为

- 只做**幂等**操作：如果文件已含相同 License 头/水印函数，会跳过而不是重复注入。
- 每一步都打印 `[guardian][step-N] ...` 日志。
- `--dry-run` 会打印将要修改的每个文件，但**不会写入**。
- 混淆开关 `--obfuscate` 依赖运行环境有 `javascript-obfuscator`；
- Python 混淆开关 `--obfuscate-python` 依赖系统已安装 `pyarmor`（商业软件，请确认授权合规）；
  若未安装，脚本会给出**明确安装提示**并跳过混淆步骤（不影响 ①②③）。

## Skill 的执行契约（给调用方 LLM）

- **必须**执行 `node skills/skill-guardian/scripts/guardian.js` 而不是自行拼装 License/水印代码。
- **禁止**把目标 skill 的源码读进上下文再让模型改；直接把参数交给脚本即可。
- 脚本执行完后，向用户回报四层保护的启用状态清单。

## 相关文档

- `references/guardian-details.md` — 每一层保护的技术细节与"能挡什么、挡不住什么"
- `templates/license-header.js.txt` / `templates/license-header.py.txt` — JS / Python License 头模板
- `templates/LICENSE.template` — 完整 LICENSE 文件模板（含 `{{JURISDICTION}}` 占位符）
- `templates/runtime-guard.snippet.js` / `templates/runtime-guard.snippet.py` — 运行时校验 + 水印代码片段模板
- `.guardianignore` — 可选，扩展 walk 排除项（语法参见 README）
