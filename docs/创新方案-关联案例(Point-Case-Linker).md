# 基于测试任务插件的测试要点⇄测试案例智能关联匹配（Point-Case Linker）方案

## 一、项目背景

在测试资产治理中，测试要点（`.md` / `.xmind`）与测试案例（yaml/json/csv）长期由不同团队、多套格式分别维护，二者之间缺乏结构化关联。工程师写好要点后，必须在成百上千条案例中人工逐条核对覆盖关系——**"要点对应哪些案例、某条案例服务于哪个要点"没有快速答案**，只能靠肉眼翻找，既慢又易漏。

核心诉求非常明确：**在海量案例数据下，能否一键、秒级、准确地查到要点与案例的映射关系?** 现有做法存在三道坎：

1. **查不动**：数据量大（单文件上万条案例、多格式混杂）时，遍历比对成本极高，肉眼基本不可行。
2. **查不准**：大量团队使用中文表头 CSV（「名称/路径/前置条件」），按英文字段名取值的引擎直接 0 命中。
3. **查不全**：parent_id 拆分、path 同构、重复/孤儿案例等边界情况无人处理，覆盖率统计失真。

本项目目标是：依托**测试任务插件**（VSCode 扩展）这一既有底座，在其"测试任务/测试大纲/测试案例"资产体系之上，构建一套**高性能关联检索引擎**，让"要点—案例"关系由系统即时推导，把人工核对从"分钟级翻找"压缩为"一键查看"。

## 二、技术方案

本方案的能力完全构建在测试任务插件之上：插件提供命令面板、工作区目录约定（`测试任务/<任务名>/测试大纲/`、`测试任务/<任务名>/测试案例/`）与扩展进程运行时，方案在其内以四层模块落地。核心能力是**快速查看要点与案例的映射关系**，围绕"快、准、稳"三个目标，引擎层重点攻克检索算法与性能，上层负责编排与呈现。

### 2.1 一键查看的整体链路

用户只需在命令面板触发"关联匹配诊断"，系统即从当前要点文件（`.md` 或 `.xmind`）出发，读取绑定 → 解析要点 → 调用检索引擎 → 返回结构化映射。四层结构各司其职：

```mermaid
flowchart TB
    subgraph UI层["UI层"]
        direction TB
        A["命令面板\ntestcaseViewer.diagnosticLinker"]
    end

    subgraph 应用层["应用层 · linkerDiagnosticHandler.ts"]
        direction TB
        G["getLinkedCasesByMdFile\n业务级一站入口"]
        M["parseMdToPointListSilent\nmd→pointList 静默解析"]
        L["linkAndAggregateCases\n匹配聚合·纯函数"]
        DH["detectCsvHeaderOptions\n中文表头嗅探"]
    end

    subgraph 绑定层["绑定层 · pointCaseBindingStore.ts"]
        direction TB
        B1["getCaseOfPoint\nmd→案例绝对路径 | null"]
        BF[("point-case-bindings.json")]
    end

    subgraph 引擎层["引擎层 · pointCaseLinker.ts（检索核心）"]
        direction TB
        E1["buildIndex\nO(P)建索引"]
        E2["matchCore\n三档匹配"]
        E3["LRU 缓存\npath+mtime+size 作 key"]
        E4["parseFileToRows\nYAML/JSON/CSV 解析"]
    end

    subgraph 存储层["存储层"]
        direction TB
        FS[("测试要点 .md / .xmind")]
        CF[("测试案例 yaml/json/csv")]
    end

    A --> G
    G --> M
    G --> B1
    G --> L
    L --> DH
    L --> E1
    E1 --> E2
    E2 --> E3
    E2 --> E4
    M --> FS
    E4 --> CF
    B1 --> BF

    style A fill:#FCE4EC,stroke:#F48FB1,color:#616161
    style G fill:#E3F2FD,stroke:#90CAF9,color:#616161
    style M fill:#E3F2FD,stroke:#90CAF9,color:#616161
    style L fill:#E3F2FD,stroke:#90CAF9,color:#616161
    style DH fill:#E3F2FD,stroke:#90CAF9,color:#616161
    style B1 fill:#E8F5E9,stroke:#A5D6A7,color:#616161
    style BF fill:#E8F5E9,stroke:#A5D6A7,color:#616161
    style E1 fill:#FFF3E0,stroke:#FFCC80,color:#616161
    style E2 fill:#FFF3E0,stroke:#FFCC80,color:#616161
    style E3 fill:#FFF3E0,stroke:#FFCC80,color:#616161
    style E4 fill:#FFF3E0,stroke:#FFCC80,color:#616161
    style FS fill:#E0F7FA,stroke:#80DEEA,color:#616161
    style CF fill:#E0F7FA,stroke:#80DEEA,color:#616161
    style UI层 fill:#FCE4EC,stroke:#F48FB1,stroke-width:2px,color:#616161
    style 应用层 fill:#E3F2FD,stroke:#90CAF9,stroke-width:2px,color:#616161
    style 绑定层 fill:#E8F5E9,stroke:#A5D6A7,stroke-width:2px,color:#616161
    style 引擎层 fill:#FFF3E0,stroke:#FFCC80,stroke-width:2px,color:#616161
    style 存储层 fill:#E0F7FA,stroke:#80DEEA,stroke-width:2px,color:#616161
```

端到端数据流如下（纵向链路），可见"查看关系"仅需一次调用即可拿到完整映射：

```mermaid
flowchart TB
    U["① 用户命令面板一键触发\ndiagnosticLinker"] --> G["② 一站入口 getLinkedCasesByMdFile\n校验扩展名/入参 + 解析要点 + 查 1:1 绑定"]
    G -->|"校验失败 / 未绑定"| ERR["⊘ 短路返回 envelope.errorMsg\n（提示未绑定 / 类型错误等）"]
    G -->|"已绑定"| EN["③ 引擎层 linkPointsToCases\n建索引 + 三档检索匹配（中文表头自动嗅探）"]
    EN --> OUT["④ 输出 LinkedCasesEnvelope\n要点→案例映射 + 命中分布 / 孤儿等 stats"]
    OUT --> R["⑤ 秒级呈现关联结果\n+ telemetry 埋点"]

    style U fill:#FCE4EC,stroke:#F48FB1,color:#616161
    style G fill:#E3F2FD,stroke:#90CAF9,color:#616161
    style ERR fill:#FFEBEE,stroke:#EF9A9A,color:#616161
    style EN fill:#FFF3E0,stroke:#FFCC80,color:#616161
    style OUT fill:#E8F5E9,stroke:#A5D6A7,color:#616161
    style R fill:#FCE4EC,stroke:#F48FB1,color:#616161
```

### 2.2 亮点一：高性能检索算法（核心）

引擎的检索核心由两步构成，**面向大数据量做了算法级优化**：

**① 一次建索引（`buildIndex`，O(P)）**
进入匹配前，对全部要点 pointList 一次性构建两张 `Map`：`byId`（pointId→点）与 `byPath`（归一化 path→点）。后续每条案例的查找都是 **O(1) 哈希命中**，而非逐条线性比对——这是大批量数据下"查得快"的关键。

**② 单次遍历匹配（`matchCore`，O(C)）**
对每条案例记录只走一遍决策链，给出可量化的匹配强度：

- `type=1`：parent_id 与 path 同时精确命中（最强）
- `type=2`：仅 parent_id 命中（含 `-N` 尾号剥离回退，兼容拆分场景）
- `type=3`：仅 path 兜底命中（兼容无编号要点）
- 二者皆否 → 记为孤儿案例

由于索引是哈希查表，**整体复杂度仅 O(P) + O(C)**，与"逐条 × 逐条"的 O(P×C) 暴力比对相比呈数量级下降，这正是上万条案例仍能秒级返回的根因。

### 2.3 亮点二：大批量数据照样快——三层缓存

针对"编辑器反复刷新、推送、反复查看"的高频场景，引擎内置三处独立缓存，让大数据文件几乎零重复解析：

- **引擎层 fileCache（重头戏）**：key = `path + mtimeMs + size`，容量 64。案例文件未变时直接复用解析结果，**热调用近乎零成本**；案例一保存（mtime 变）即自动失效重解析，保证结果新鲜。
- **绑定层 cacheByRoot**：按 workspace 根目录缓存整份绑定 JSON，mtime 校验失效。
- **绑定层 globalBoundFileMap**：装饰器 O(1) 查询，5s TTL + 写入即失效，削峰高频刷新。

实测：**P=1000 要点 × C=10000 案例的热调用 < 30ms（不含首次 IO）**，即便案例文件达万级规模，查看映射依旧秒级响应。

**缓存实时性边界（重要工程权衡）**：三处缓存均以 `mtime` 作为失效判据，因此存在一条明确边界——**VSCode 内编辑了要点/案例文件但未保存时，mtime 未变，读到的是磁盘旧内容；必须保存后再次触发，才能看到最新匹配结果**。外部工具（脚本、Git）改动文件会更新 mtime，自动重解析。该边界是有意设计：以"保存即生效"换取热路径近乎零解析开销，而非牺牲性能去监听未保存内容。上层 UI 已在命令说明与 Output 提示中引导用户"保存后再查看"，避免误判为匹配失效。

### 2.4 命令入口守卫与稳定出参契约

**① 命令入口守卫**
"关联匹配诊断"命令由测试任务插件的命令面板（`testcaseViewer.diagnosticLinker`）触发，并受两道约束保护，确保只在本插件资产体系内运行：一是 `when` 条件限定命令仅在插件激活上下文可用；二是从当前激活编辑器 / 标签页取到要点文件后，先校验扩展名必须为 `.md` / `.xmind`，再校验其路径必须命中 `测试任务/<任务名>/测试大纲/xxx.(md|xmind)` 正则。两道守卫把"误对无关文件执行关联"在入口处拦截，与架构文档的扩展名分派、路径正则约束完全一致。

**② 稳定出参契约与五步失败短路**
全链路统一返回 `LinkedCasesEnvelope { total, errorMsg, data, stats }`。业务级一站入口 `getLinkedCasesByMdFile` 内部按"入参校验 → 扩展名分派 → md 解析抽点 → 读 1:1 绑定 → 案例文件存在性校验"**五步顺序短路**：任一步不满足即立即返回同形状 envelope（`{ total: 0, errorMsg, data: {} }`），不抛异常、不弹 UI，调用方永远只需检查 `errorMsg` 与 `total` 两处，无需 try/catch。错误路径从"未绑定 / 非 md / 引擎抛错 / 文件缺失"到"正常命中"被收敛为同一契约，便于上层一致呈现"该要点关联的案例清单"。

### 2.5 中文表头零改引擎

针对中文 CSV 模板，应用层 `detectCsvHeaderOptions` 只读首行 ≤8KB，识别「名称/路径/用例编号/父点编号」等中文别名，覆盖 `LinkOptions` 字段名后传给统一引擎——**引擎与解析器零侵入**，新增团队方言只需在常量表加词。让中文大数据文件也能即查即中。

### 2.6 1:1 关系持久化与乐观锁

绑定层以插件工作区内的 `.plugin/.tms/point-case-bindings.json` 落盘（相对路径 + POSIX 分隔符，跨平台稳定，依托插件工作区隔离不同任务）。写入侧 `setPointCases` 若传入 >1 个案例直接抛错，从源头保证 1:1 不变性；多窗口并发引入乐观锁 `expectedMtimeMs`，冲突即重试，避免绑定丢失。

### 2.7 全链路自观测埋点

统一上报 `linkerDiagnostic.done/.linkerError` 与 `pointCaseLinker.done/.duplicatePointId/.multiHitCase` 等事件，覆盖使用频次、失败率、三档命中分布、孤儿率、耗时分位（P50/P95/P99），脏数据信号可直连告警面板，便于持续观测"查看"的质量与性能。

### 2.8 已落地的扩展能力

除核心的"要点→案例"正向关联外，方案还基于同一引擎沉淀了多项可直接复用的能力：

- **反向查询（案例→要点）**：引擎 `LinkResult.byCase` 已提供 `{pointKey, type}` 反查结构，应用层可经 `getPointOfCase(casePath)` 直接给出"某条案例服务于哪个要点"，双向关联闭环。
- **Tree View / 资源管理器徽标**：绑定层 `getGlobalBoundFileMap` 提供 O(1) 元信息查询（5s TTL + 写入即失效），供文件装饰器高频刷新显示"已绑定"标记，让资产关系在侧边栏可视化。
- **未绑定兜底扫描**：应用层保留 `locateCaseDir + collectCaseFiles`（向上找"测试案例"目录并递归收集 yaml/yml/json/csv），在未显式绑定时可自动发现候选案例文件，降低手动绑定成本。
- **批量并发匹配**：引擎层 `linkPointsToCasesBatch` 已就绪（索引只构建一次、按 `concurrency` 默认 4 并发、单文件失败不影响其余），为未来多点 / 多案例批量关联场景提供能力储备。
- **XMind 要点解析**：`parseXmindToPointListSilent` 已接入扩展名分派，与 `.md` 共用后续链路，思维导图式要点无缝参与关联。

## 三、成果展示

- **一键秒查映射**：命令面板触发，秒级呈现某要点文件（`.md` / `.xmind`）关联的全部案例，并按 `type=1/2/3` 标注匹配强度，反向关系（案例属于哪个要点）同样可查。
- **大数据量依旧快**：万级案例热调用 < 30ms；LRU + mtime 双校验让"案例一保存即生效"，编辑器反复刷新、推送场景近乎零解析开销。
- **中文模板开箱即用**：中文表头 CSV 无需改引擎即可命中（type=2 兜底），英文/yaml/json 回归不受影响，已通过专项单测验证。
- **数据质量可见**：统计实时呈现命中分布、孤儿数、重复 pointId、多点命中案例，为资产治理提供量化抓手。
- **XMind 要点已支持**：测试要点除 `.md` 外已支持 `.xmind` 格式，命令面板与解析分支自动分派，思维导图式要点同样可秒级查到案例映射。
- **测试保障**：引擎层 19 项单测 + 千条案例集成验证（yaml/json/csv）+ 中文 CSV 兼容专项，全链路可回归。

### 3.1 压测数据（检索性能）

为验证"大批量数据也能快速查到映射关系"，对引擎核心 `linkPointsToCases` 做分档压力测试。测试口径：要点数 P 固定为 1000，案例记录数 C 递增；**热调用（即案例文件已入 LRU 缓存、仅做索引+匹配，不含首次 IO 解析）**，单文件单线程，取 100 次平均耗时。

| 案例规模 C | 要点数 P | 热调用平均耗时 | 备注 |
|---|---|---|---|
| 1,000 | 1,000 | 3.2 ms | 千级，轻松秒回 |
| 5,000 | 1,000 | 11.5 ms | 五千级 |
| 10,000 | 1,000 | 28.6 ms | 万级，仍 < 30ms |
| 20,000 | 1,000 | 61.0 ms | 两万级，亚秒级 |
| 50,000 | 1,000 | 152.3 ms | 五万级，稳定亚秒 |

耗时随案例量近似线性增长（O(C)），印证哈希索引检索的复杂度优势——即便案例文件达 5 万条，单次查看映射仍控制在 200ms 内，人机交互无感。

```mermaid
xychart-beta
    title "热调用平均耗时 vs 案例规模（P=1000）"
    x-axis ["1K", "5K", "10K", "20K", "50K"]
    y-axis "平均耗时 (ms)" 0 --> 200
    bar [3.2, 11.5, 28.6, 61.0, 152.3]
```

> 首次冷调用需额外叠加文件解析 IO（yaml/json/csv 解析），随文件体积增长；但因 `fileCache`（容量 64，key=path+mtimeMs+size）缓存解析结果，**同一文件二次及后续查看即进入上表热调用区间**，编辑器反复刷新、推送场景近乎零重复解析开销。

### 3.2 命中质量分布（千条集成样例）

在 `yaml/json/csv` 三类共 1000 条案例 + 200 个要点的集成验证中，三档命中与脏数据信号统计如下：

| 指标 | 数值 | 说明 |
|---|---|---|
| 总案例记录 | 1,000 | 跨三类格式 |
| type=1 精确命中 | 412 | parent_id + path 同点，最强 |
| type=2 parent_id 命中 | 358 | 含 `-N` 尾号剥离回退 |
| type=3 path 兜底 | 176 | 无编号要点也能关联 |
| 孤儿案例 | 54 | 需补 parent_id / path |
| 尾号剥离次数 | 87 | 拆分场景自动归一 |

```mermaid
pie
    title "三档命中分布（千条集成样例）"
    "type=1 精确" : 412
    "type=2 parent_id" : 358
    "type=3 path 兜底" : 176
    "孤儿" : 54
```

数据显示：超 94% 的案例可被自动关联到要点，**仅约 5% 孤儿需人工补列**，关联覆盖率与可用性得到量化验证。

## 四、项目总结

### 4.1 创新性

以"**快速查看要点—案例映射**"为核心诉求，提出"**哈希索引检索 + 三档强度 + 零侵入中文适配**"的关联范式：用 O(1) 哈希索引替代 O(P×C) 暴力比对，用 type=1/2/3 量化关联置信度；中文表头采用"嗅探覆盖而非改引擎"的零侵入方案，兼顾多团队方言。属测试资产关联检索领域的工程化首创。

### 4.2 质量提升

脏数据信号（重复 pointId、多点命中、孤儿案例）首次被系统化采集并可视化，覆盖率统计由"凭感觉"转为"看指标"；表头弹性识别与转义竖线容错显著降低了格式错配导致的误判，让查到的映射更可信。

### 4.3 效能提升

将工程师"逐条肉眼核对"的工作自动化为"一键查看"，单次关联从分钟级降到秒级（热调用 <30ms）；三处缓存使大批量数据下的反复查看近乎零解析开销，综合人力成本与等待时间同步下降。

### 4.4 难度

难点集中在检索算法的索引设计（O(1) 建表与单次遍历匹配）、万级数据下的缓存失效语义（mtime+size 双校验）、中文模板零侵入适配、1:1 并发一致性（乐观锁），以及 parent_id 尾号剥离回退等边界逻辑，工程实现与测试覆盖均有较高门槛。

### 4.5 推广价值

方案对"要点—案例"这一通用关联场景高度抽象，框架无关、契约稳定、检索高效，可直接复用于其他研发域的"需求—用例""缺陷—案例"关联检索；已支持的 XMind 要点解析、批量并发、兜底扫描等扩展点，使其具备向大型测试平台演进为通用关联检索中台的能力。
