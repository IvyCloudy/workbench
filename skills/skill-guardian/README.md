# skill-guardian

一键为任意 skill 项目加上四层版权保护 —— **License 头 · manifest 完整性校验 · 水印 · 可选混淆**。

## 快速开始

```bash
# 用默认配置为 yaml-format-fix 加固
node skills/skill-guardian/scripts/guardian.js skills/yaml-format-fix

# 离线校验一个 skill 是否被篡改（exit 0 通过 / 97 篡改）
node skills/skill-guardian/scripts/guardian.js verify skills/yaml-format-fix

# 卸载 guardian 注入的 License 头 + 守卫块（保留 LICENSE / manifest.json）
node skills/skill-guardian/scripts/guardian.js unguard skills/yaml-format-fix

# 定制作者/组织/年份/法域
node skills/skill-guardian/scripts/guardian.js skills/my-skill \
    --author "张三" \
    --org "Data Platform Team" \
    --year 2026 \
    --version 1.0.0 \
    --jurisdiction "the People's Republic of China"

# 加上混淆（JavaScript）
node skills/skill-guardian/scripts/guardian.js skills/my-skill --obfuscate

# 加上 Python 混淆（需预装 pyarmor）
node skills/skill-guardian/scripts/guardian.js skills/my-skill --obfuscate-python

# 同时开 JS + Py 混淆
node skills/skill-guardian/scripts/guardian.js skills/my-skill --obfuscate --obfuscate-python \
    --pyarmor-args "--restrict --expired 2027-01-01"

# 预览不写入
node skills/skill-guardian/scripts/guardian.js skills/my-skill --dry-run

# 已加固过的 skill，改作者/年份/版本后刷新旧信息
node skills/skill-guardian/scripts/guardian.js skills/my-skill \
    --author "张三" --year 2027 --version 2.0.0 --refresh
```

## 已加固 skill 改元信息：`--refresh`

默认情况下 Step 2/3 发现已存在 License 头 / 守卫块会 **skip**。当你需要改作者/年份/版本/组织等元信息时，
加上 `--refresh`，guardian 会：

1. 剥离每个源文件顶部的旧 License 头（根据 `Unauthorized copy …` 标识定位），重新注入新头；
2. 剥离 `// ── GUARDIAN BEGIN … GUARDIAN END ──` 整段，重新注入含新作者/年份的水印代码；
3. Step 4 照常重新扫描 SHA256 写入 `manifest.json`。

```bash
node skills/skill-guardian/scripts/guardian.js skills/yaml-format-fix \
    --author "张三" --org "Data Platform" --year 2027 --version 2.0.0 --refresh
```

日志展示：

```
[guardian][step-2] Injecting License headers into source files
  ↻ refresh: stripped old header: scripts/main.js
  ✓ header re-injected: scripts/main.js

[guardian][step-3] Injecting runtime integrity guard + watermark
  ↻ refresh: stripped old guard block: scripts/main.js
  ✓ guard re-injected: scripts/main.js
```

## 目录结构

```
skill-guardian/
├── SKILL.md                          # skill 说明（给 LLM 读）
├── README.md                         # 用户手册（本文档）
├── package.json
├── .guardianignore                   # 可选：类 .gitignore 排除清单
├── .guardianrc.json                  # 可选：默认配置
├── scripts/
│   └── guardian.js                   # 主脚本（唯一执行入口）
├── templates/
│   ├── LICENSE.template              # LICENSE 文件模板（含 {{占位符}}）
│   ├── license-header.js.txt         # 每个 JS/TS 文件顶部注入的注释块
│   ├── license-header.py.txt         # 每个 Python 文件顶部注入的注释块
│   ├── runtime-guard.snippet.js      # 运行时校验+水印代码片段（JS）
│   └── runtime-guard.snippet.py      # 运行时校验+水印代码片段（Python）
└── references/
    └── guardian-details.md           # 每层保护细节、能挡什么、挡不住什么、FAQ
```

## 五个执行步骤

| Step | 动作 | 幂等 |
|---|---|---|
| 1 | 写入/覆盖 `LICENSE` 全文 | 是（覆盖） |
| 2 | 在每个 `.js/.ts/.py` 源文件顶部注入 License 头 | 是（有标记则跳过） |
| 3 | 在 `scripts/*.js` `scripts/*.py` 中注入 `verifyIntegrity` + `printWatermark` 函数定义 | 是（有 `GUARDIAN BEGIN` 标记则跳过） |
| 4 | 生成 `manifest.json`（受保护文件的 SHA256 清单） | 是（每次覆盖） |
| 5 | *可选*：用 `javascript-obfuscator` 生成 `*.min.js` | 需要 `--obfuscate` |
| 6 | *可选*：用 `pyarmor` 加密 `scripts/*.py` → `scripts/dist_pyarmor/` | 需要 `--obfuscate-python` |

## 产物清单（执行后会新增/修改什么）

| 路径 | 由哪一步产生 | 说明 |
|---|---|---|
| `LICENSE` | Step 1 | 每次运行都会**覆盖** |
| 源文件顶部注释块 | Step 2 | 幂等注入，可用 `--refresh` 更新 |
| 源文件底部 `GUARDIAN BEGIN … END` | Step 3 | 幂等注入 `verifyIntegrity` / `printWatermark` 函数体 |
| `manifest.json` | Step 4 | 记录每个受保护文件的 SHA256，**每次覆盖** |
| `scripts/*.min.js` | Step 5（可选） | 混淆产物；**默认不进 manifest**，需显式加入 `protectedFiles` |
| `scripts/dist_pyarmor/` | Step 6（可选） | pyarmor 加密产物 + 运行时；部署时需一同分发 |

## 配置优先级

**命令行参数 > `.guardianrc.json` > 默认值**

### 默认值

| 参数 | 默认值 |
|---|---|
| author | `myronliu` |
| org | `Tencent Cloud Big Data` |
| year | 当前年份 |
| license | `Proprietary Internal-Use License` |
| jurisdiction | `the People's Republic of China` |
| skillName | 目标目录名 |
| version | 从 `SKILL.md` 提取，否则 `1.0.0` |
| obfuscate | `false` |
| obfuscatePython | `false` |
| pyarmorArgs | `""` |
| refresh | `false` |
| protectedFiles | 自动扫描 `*.md/js/ts/py/txt/json` |

### `.guardianrc.json` 示例

放到目标 skill 根目录：

```json
{
  "author": "张三",
  "org": "Data Platform",
  "year": 2026,
  "license": "Proprietary Internal-Use License",
  "jurisdiction": "the People's Republic of China",
  "skillName": "my-skill",
  "version": "1.2.0",
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

### `.guardianignore`（可选）

语法接近 `.gitignore`：一行一条，`#` 注释，支持**精确路径 / 目录（末尾 `/`）/ 简易 glob**。
默认已排除 `node_modules` / `.git` / `dist` / `dist_pyarmor` / `__pycache__` / `.venv` 等，
这里只需追加项目特有的：

```gitignore
*.min.js
*.min.js.map
tmp/
*.log
.DS_Store
```

### `protectedFiles` 支持的三种写法

| 写法 | 示例 | 语义 |
|---|---|---|
| 精确相对路径 | `scripts/main.js` | 单文件 |
| 目录路径 | `references/` 或 `references` | 递归吸收目录下所有文件 |
| Glob 通配 | `scripts/**/*.js`, `docs/*.md` | 支持 `*` / `?` / `**` / `[abc]` |

## 加固后你需要做的最后一步

Guardian 只**定义**了 `verifyIntegrity` / `printWatermark`，不会自动调用（避免破坏入口）。
请在入口脚本的 `main()` 开头手动加两行：

```javascript
function main() {
    const logger = console; // 或你自己的 logger
    const integrity = verifyIntegrity(logger);
    printWatermark(logger, integrity.manifest);
    // ...你原本的逻辑
}
```

Python 版：

```python
def main():
    logger = ... # 你的 logger
    result = verify_integrity(logger)
    print_watermark(logger, result.get('manifest'))
```

## 混淆依赖

### JavaScript（`--obfuscate`）

```bash
npm install --save-dev javascript-obfuscator
```

### Python（`--obfuscate-python`）

```bash
pip install pyarmor
pyarmor -v   # 确认可用
```

> ⚠️ `pyarmor` 是商业软件（有免费额度），请自行确认授权合规。产物默认写入
> `scripts/dist_pyarmor/`，含 `pyarmor_runtime_*/` 运行时目录；部署时需一同分发。
> 可通过 `--pyarmor-args "..."` 透传高级 flag（如 `--restrict --expired 2027-01-01`）。

未安装时 guardian 会**跳过对应混淆步骤**并给出安装提示，其他步骤不受影响。

## CI 集成示例

把 `verify` 作为质量门禁，任何篡改都会导致 CI 失败（exit code = 97）。

### GitHub Actions

```yaml
# .github/workflows/skill-guardian-verify.yml
name: skill-guardian-verify
on: [push, pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - name: Verify each skill
        run: |
          set -e
          for d in skills/*/; do
            [ -f "$d/manifest.json" ] || continue
            echo "::group::verify $d"
            node skills/skill-guardian/scripts/guardian.js verify "$d"
            echo "::endgroup::"
          done
```

### npm scripts

```json
{
  "scripts": {
    "guard":   "node skills/skill-guardian/scripts/guardian.js",
    "verify":  "node skills/skill-guardian/scripts/guardian.js verify",
    "unguard": "node skills/skill-guardian/scripts/guardian.js unguard"
  }
}
```

然后 `npm run verify -- skills/my-skill` 即可。

### 严格模式（运行时门禁）

把环境变量 `SKILL_STRICT=1` 传入生产环境，`verifyIntegrity` 检测到篡改会以 exit code `97` 立即终止进程，而不是仅打印告警：

```bash
SKILL_STRICT=1 node skills/my-skill/scripts/main.js
```

## 详细技术说明

见 [`references/guardian-details.md`](./references/guardian-details.md) —— 每层保护"能挡什么、挡不住什么"的完整分析。
