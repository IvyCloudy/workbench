# Guardian 各层保护详解 —— 能挡什么 / 挡不住什么

## ① License 头（源码文件顶部注释）

- **做了什么**：在每个 `.js/.ts/.py` 源文件顶部注入一段 Copyright + License 声明。
- **强度**：**声明性 · 震慑性**。让任何打开代码的人第一时间看到版权声明。
- **能挡**：随手 Ctrl+C / 好奇心复制的场景；后续追责时的**书面证据**。
- **挡不住**：故意删掉注释的人。但删除本身就构成 License §2(c) 违约。

## ② LICENSE 文件 + 运行时完整性校验（`manifest.json`）

- **做了什么**：
    1. 生成 `LICENSE` 全文文件；
    2. 生成 `manifest.json`，包含**每个受保护文件的 SHA256**；
    3. 在每个入口脚本注入 `verifyIntegrity(logger)`，运行时逐文件重算 hash 与 manifest 对比。
- **强度**：**强 —— 挡篡改**。任何修改（改代码、改 README、改 LICENSE）都会破坏 hash。
- **默认**：mismatch 只打印告警，不中断执行（方便开发调试）。
- **严格模式**：设置环境变量 `SKILL_STRICT=1`，mismatch 时以退出码 97 立即终止。
- **能挡**：改脚本、删注释、替换 LICENSE、悄悄替换某个 md。
- **挡不住**：连 `manifest.json` 一起替换重新签名的对手 —— 但这需要对手也持有你的构建流程。

## ③ 水印（`printWatermark`）

- **做了什么**：运行时打印一行：
  ```
  [<skill-name> v<version>] © <YEAR> <author> · <license-short> · fingerprint=<8位hex>
  ```
- **fingerprint** = `sha256(hostname|username|platform|arch)[:8]` — 脱敏，但唯一。
- **强度**：**强 —— 挡泄漏溯源**。日志、截图、bug 反馈里都会带上运行者的机器指纹。
- **能挡**：只要有人跑一次并留下日志/截图，就能定位到"是哪台机器/哪个人"。
- **挡不住**：完全离线、不发日志、并且删掉 `printWatermark` 调用的对手。但删除也是 §4 违约证据。

## ④ 混淆（可选）

### JavaScript — `javascript-obfuscator`

- **做了什么**：把 `scripts/*.js` 用 [javascript-obfuscator](https://obfuscator.io) 变换成：
    - 变量/函数名 → `_0xabc123` 十六进制
    - 字符串抽取到数组 + Base64 编码
    - 控制流平坦化（`if/for` → 状态机 `switch`）
    - 死代码注入（随机塞入永远不执行的假逻辑）
    - `selfDefending`（一旦被 beautify 就崩溃）
- **强度**：**强 —— 挡逆向/抄袭**。人肉阅读几乎不可能，AI 阅读准确率也大幅下降。
- **默认关闭**：因为 `javascript-obfuscator` 是可选依赖，需要 `npm i -D javascript-obfuscator` 才生效。

### Python — `pyarmor`（商业）

- **做了什么**：开关 `--obfuscate-python` 后，guardian 会探测系统上的 `pyarmor`，并在
  `scripts/` 目录下执行：
  ```bash
  pyarmor gen -O dist_pyarmor [--pyarmor-args …] <所有 .py>
  ```
  产物写入 `scripts/dist_pyarmor/`，包含加密后的 `.py` 与 `pyarmor_runtime_*/` 运行时。
- **强度**：**很强**。pyarmor 本质上是"源码 → 专有字节码/机器码 + 运行时解密"，重命名/字符串加密/环境绑定/过期时间都可选；与 `.pyc` 字节码相比，**无法用 `uncompyle6`/`decompyle3` 直接还原**。
- **默认关闭**：`pyarmor` 是商业软件（有免费额度），需要 `pip install pyarmor` 才生效；使用前请确认授权合规。
- **能挡**：逆向阅读、抄袭重写、本地无限期拷贝使用（配合 `--restrict --expired`）。
- **挡不住**：拿到你的 pyarmor 授权重新打包的内部人员；运行时 hook / debug attach 拓印的高阶对手。
- **充分利用**：搭配 `--pyarmor-args "--restrict --expired 2027-01-01"` 写入时间/机器限制；将产物写入 `.guardianrc.json` 的 `protectedFiles`，再跑一次 `guardian`（不带 `--obfuscate-python`）让 manifest 覆盖到加密后的 `.py`。

### 关于混淆的整体定位

- **提高门槛，而非绝对安全**。与 ①②③ 组合使用效果最佳。
- **能挡**：
    - 随手拿去改改就用的抄袭者；
    - LLM 直接读代码解读；
    - 快速定位并删除 `verifyIntegrity` / `printWatermark` 的调用。
- **挡不住**：
    - 决心足够 + 有反混淆工具（`synchrony` / `webcrack`）的逆向工程师，几小时到一天可还原到"能读"程度；
    - 动态运行时抓行为（外面包一层 log）。

## 子命令

guardian.js 提供三个子命令（第一个位置参数），默认省略即为 `guard`：

| 子命令 | 作用 | 常用场景 | 退出码 |
|---|---|---|---|
| `guard` | 执行完整加固流程（默认） | 首次加固、`--refresh` 更新元信息 | `0` |
| `verify` | 离线重算 SHA256 与 `manifest.json` 对比，**不改文件** | CI 质量门禁、部署前预检 | `0` 通过 / `97` 篡改 |
| `unguard` | 逐文件剥离 License 头 + 运行时守卫块（保留 `LICENSE` / `manifest.json`） | 试用后回滚 | `0` |

```bash
node scripts/guardian.js verify  skills/my-skill
node scripts/guardian.js unguard skills/my-skill
```

> `verify` **不依赖**运行时守卫代码是否被调用，是一次纯离线校验，适合放在 CI 里做门禁。
> `unguard` 只清理 guardian 注入过的内容（有明确的 `GUARDIAN BEGIN…END` 标记与 License 头指纹），
> **不会碰**业务代码。

## 组合防御矩阵

| 攻击类型 | ① 头 | ② manifest | ③ 水印 | ④ 混淆 |
|---|---|---|---|---|
| 顺手抄一份提交到自己仓库 | ✓ | ✓ | ✓ | ✓ |
| 悄悄改一行代码去掉限制 | ✗ | ✓ | ✓ | ✓（延缓） |
| 泄漏到外网/被截图 | ✗ | ✗ | ✓ | ✗ |
| 读懂后重写一个"平替" | ✗ | ✗ | ✗ | ✓（延缓） |
| 完整替换 manifest + 删水印 | ✗ | ✗ | ✗ | ✓（延缓） |

结论：**四层协作** 才能形成有效威慑；缺一层就多一个绕过口子。

## FAQ

**Q1：注入的 `verifyIntegrity` / `printWatermark` 自动调用了吗？**
A：**没有**。为避免破坏你的入口逻辑，guardian 只**定义**这两个函数，需要你在入口 `main()` 开头手动加：

```javascript
const integrity = verifyIntegrity(logger);
printWatermark(logger, integrity.manifest);
```

**Q2：`--obfuscate` 之后 manifest 里还是原文件的 hash，怎么办？**
A：混淆产物 `*.min.js` 默认**不进** manifest。如需覆盖，在 `.guardianrc.json` 的
`protectedFiles` 中列出 `scripts/*.min.js`，然后**先混淆、后生成 manifest**——即先跑
一次 `--obfuscate` 再跑一次不带该 flag 的 guardian，或干脆用 shell 分两步。`--obfuscate-python`
同理：pyarmor 产物默认不进 manifest，需把 `scripts/dist_pyarmor/**` 加到 `protectedFiles`
后再跑一次不带 `--obfuscate-python` 的 guardian。

**Q3：能给非 JS/Python 的 skill 用吗？**
A：① LICENSE 头目前只处理 `.js/.ts/.mjs/.cjs/.py`；② manifest.json 是**语言无关**的，任何
文件都可以纳入受保护清单；③ 水印 JS/Py 都支持；④ 混淆：JS 走 javascript-obfuscator，Python 走 pyarmor（商业）。

**Q4：加固完之后想改作者/版本/年份，重跑 guardian 却发现 skip 了怎么办？**
A：加上 `--refresh` 开关。guardian 会识别旧的 License 头块（`Unauthorized copy…` 标记）
和 `// ── GUARDIAN BEGIN … GUARDIAN END ──` 整段，**先剥离、再重新注入**，
manifest.json 也会跟着重算 SHA256。示例：

```bash
node scripts/guardian.js skills/my-skill \
    --author "新作者" --version 2.0.0 --year 2027 --refresh
```

**Q5：怎么把 verify 塞到 CI 里做门禁？**
A：直接调用子命令 `node guardian.js verify <dir>`。它不改动任何文件，只做 SHA256 校验，
退出码 `0` 表示 manifest 完全一致，`97` 表示至少有一个受保护文件被篡改（含误删）。GitHub
Actions / GitLab CI / Jenkins 都可以直接把它作为一步 shell 命令；若你要一次校验仓库里所有
skill，可以 `for d in skills/*/; do node scripts/guardian.js verify "$d"; done`。

**Q6：加固完的 skill 想恢复原样，需要一个个手动改吗？**
A：不用。跑 `node guardian.js unguard <dir>` 即可，guardian 会识别每个源文件顶部的 License 头
（以 `Unauthorized copy…` 为特征）与底部的 `// ── GUARDIAN BEGIN … GUARDIAN END ──` 块，
**只剥离这两段**，业务代码原样保留。`LICENSE` / `manifest.json` 是独立文件，如果不想要可以手动删除。

**Q7：`--jurisdiction` 是干什么的？**
A：写进 `LICENSE` 文件里"本许可适用于 X 的法律"这一条的国名/地区名，默认 `the People's Republic
of China`。跨境使用或需要指定其他法域时可用 `--jurisdiction "Hong Kong SAR"` 之类覆盖。
