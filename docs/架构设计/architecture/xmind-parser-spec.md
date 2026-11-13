# XMind 测试要点解析器规格

> 独立模块 `src/utils/parseXmindToPointList.ts`；不侵入现有 md 解析链路。
> 消费方：`src/handlers/linkerDiagnosticHandler.ts` 中 `getLinkedCasesByMdFile` 按扩展名分派。

## 1. 定位与设计原则

- **单一职责**：只做「一个 .xmind → PointItem[]（可选带结构错误清单）」的转换，不读绑定、不做匹配、不弹 UI、不依赖 VSCode API。
- **与 md 侧同构**：输出的 `PointItem` 严格遵循 `pointCaseLinker.ts` 中的类型（`pointId / pointName / pointPath`），下游匹配引擎无感切换。
- **不破坏现有结构**：`parseMdToPointListSilent` 保持不动；xmind 走独立 parser；两者在 handler 里按扩展名分派。
- **零 xml2js**：xmind 8 XML 用手写极简解析（只识别 `topic / title / marker-ref / label / topics[type=attached] / sheet`）；xmind ZEN JSON 用 `JSON.parse`。
- **依赖**：`jszip`（解 zip）。

## 2. 输入 / 输出契约

```ts
async function parseXmindToPointListSilent(
    xmindPath: string,
): Promise<XmindParseResult>;

interface XmindParseResult {
    pointList: PointItem[];        // 解析出的测试点；结构错误时为空
    errorMsg: string;              // 错误信息；无错为空字符串
    invalidNodes: XmindInvalidNode[]; // E3 报错清单：无图标中间节点
    warnings: XmindWarning[];      // 脏数据告警，不阻断解析
}

interface PointItem {
    pointId: string;    // 五角星节点首个 label；无 label → ''
    pointName: string;  // 五角星节点文本
    pointPath: string;  // 归一化后的完整路径（含 pointName）
}
```

**错误场景**（`errorMsg` 非空、`pointList` 为空）：

| 场景 | errorMsg 前缀 |
|---|---|
| 文件读不到 | `读取 xmind 文件失败：...` |
| 文件不是合法 zip | `xmind 文件不是合法的 zip 归档：...` |
| zip 内无 `content.json` 也无 `content.xml` | `xmind 文件内未找到 content.json 或 content.xml，可能是不受支持的 xmind 变体` |
| JSON/XML 解析异常 | `解析 xmind 内容失败：...` |
| 无有效 sheet | `xmind 文件无有效画布（sheet）` |
| 存在无图标中间节点（结构错误） | `xmind 结构错误：检测到 N 个中间节点未标记「功能条目」（小旗子）图标，请在 xmind 中补全图标后重试` |

## 3. 解析规则（最终版）

### 3.1 节点角色判定（按 markerId 前缀）

| 角色 | markerId 前缀（大小写不敏感） | 说明 |
|---|---|---|
| **测试点节点（五角星）** | `star-*` | 匹配正则 `/^star(-\|$)/i`；**仅限 star 系图标**，`priority-*`（数字圆圈优先级）不算测试点 |
| **功能条目节点（小旗子）** | `flag-*` | 匹配正则 `/^flag(-\|$)/i` |
| **说明性节点** | 处于任一「五角星节点」的祖先链下 | 忽略、不校验、不进 pointPath |
| **中间无图标节点**（结构错误） | 非根、非说明子树、无 flag/star 图标 | 收集到 `invalidNodes`；一次性列全后中止解析（E3 模式） |
| **根节点（中心主题）** | 豁免图标校验；**不**进 pointPath | — |

判定策略是 **F2**：仅关心 `flag/star` 是否存在；节点上带其他装饰性图标（如任务图标、人脸图标、**数字圆圈优先级图标 `priority-*`**）**都不算测试点标记**也不算无效标记。仅当节点同时不带 `flag`/`star` 且不在星形子树下时，才报为结构错误。

### 3.2 字段抽取

- `pointName` = 五角星节点的 `title`
- `pointId` = 五角星节点的**首个 label**；无 label → 空字符串（后续走 pointPath 匹配 type=2）
- 多 label 时取首个，并追加一条 `warnings`

### 3.3 pointPath 组装（P1 语义）

从根开始，沿 attached 主枝干下钻；对当前节点：
- **根节点**：不进 pointPath
- **flag 节点**：`title` 追加到 pointPath 尾部
- **priority/star 节点**：仅 `star-*` 作为测试点，`title` 追加到 pointPath 尾部；`priority-*` **不入测试点判定**、不入 pointPath（若同时不带 flag 且不在星形子树下，会报结构错误）
- **其他节点**：不进 pointPath（若不在星形子树下则报结构错误）

最终对拼接串走 `normalizePointPath` 归一化（与 md 侧共用同一套规则）。

**范例**：

```
中心主题
 └─ 🚩 分支主题1
     └─ 🚩 子主题1
         └─ ⭐ 测试要点 [001]
             ├─ 测试要点描述          （说明节点，忽略）
             └─ ⭐ 子主题2
```

解析产出：

| pointId | pointName | pointPath |
|---|---|---|
| `001` | `测试要点` | `分支主题1/子主题1/测试要点` |
| `""` | `子主题2` | `分支主题1/子主题1/测试要点/子主题2` |

### 3.4 嵌套测试点

- 不阻止下钻；每个五角星节点都作为独立测试点纳入
- 祖先链上的其他五角星节点也进入当前测试点的 `pointPath`

### 3.5 多 sheet / 游离主题

- **多 sheet**：处理 `content.json` 顶层数组里的每张画布，输出合并
- **游离主题（detached）**：不接入 rootTopic 主枝干，全部跳过（ZEN 侧 `children.detached`；XML 侧 `<topics type="detached">`）

## 4. 格式兼容矩阵

| xmind 版本 | 内部文件 | 处理路径 |
|---|---|---|
| xmind ZEN / 2020+ / 2024+ | `content.json` | 优先使用；`JSON.parse` → `zenTopicToNode` |
| xmind 8 及以前 | `content.xml` | 回退方案；手写极简 tokenizer 构建 `XmindNode` 树 |
| 两者共存 | 两者都在 | 优先 JSON |

XML 解析器的最小识别集：

```
<sheet><title>...</title>
  <topic>
    <title>...</title>
    <marker-refs>
      <marker-ref marker-id="..."/>
    </marker-refs>
    <labels>
      <label>...</label>
    </labels>
    <children>
      <topics type="attached">      <!-- 只有 attached 进入解析 -->
        <topic>...</topic>
      </topics>
      <topics type="detached">      <!-- 跳过 -->
        ...
      </topics>
    </children>
  </topic>
</sheet>
```

命名空间前缀（如 `content:topic`）在解析时被剥离，不影响元素识别。

## 5. 与 handler 层的集成

### 5.1 `getLinkedCasesByMdFile` 分派

```ts
if (ext === '.md') {
    pointList = await parseMdToPointListSilent(mdPath);
} else if (ext === '.xmind') {
    const xr = await parseXmindToPointListSilent(mdPath);
    pointList = xr.pointList;
    if (xr.errorMsg) return { total: 0, errorMsg: xr.errorMsg, data: {}, xmindInvalidNodes: xr.invalidNodes, xmindWarnings: xr.warnings };
    // ...
}
```

### 5.2 `LinkedCasesEnvelope` 扩展

新增两个可选字段（md 侧永远不填）：

```ts
interface LinkedCasesEnvelope {
    // ...existing fields...
    xmindInvalidNodes?: XmindInvalidNode[];   // 结构错误清单
    xmindWarnings?: XmindWarning[];           // 脏数据告警
}
```

### 5.3 Output Channel 输出

统一走 `appendXmindDiagnosticsToChannel(ch, envelope)`：

- **结构错误**：`⚠️ xmind 结构错误：以下 N 个中间节点缺少图标标记` + 逐条列出 `[画布] 根 → A → B → 当前`
- **告警**：`ℹ️ xmind 脏数据告警（不影响解析）共 N 条` + 逐条列出

命令面板入口 `handleLinkerDiagnostic` 会调用该函数，保证输出格式一致。

## 6. 单测覆盖

`src/test/parseXmindToPointList.test.ts` 用 JSZip 手工构造 fixture，覆盖 10 个用例：

| # | 场景 | 断言重点 |
|---|---|---|
| ① | 基础一个测试点 | pointPath 完整；无错误无告警 |
| ② | 嵌套测试点（P1 语义） | 祖先五角星进入 pointPath |
| ③ | 无 label 测试点 | `pointId === ''` |
| ④ | 多 label 告警 | 取首个 label；warnings 非空 |
| ⑤ | 无图标中间节点 | errorMsg 非空；invalidNodes 列全；pointList 为空 |
| ⑥ | 说明节点 | 无错误；说明节点被忽略 |
| ⑦ | 多 sheet | 所有 sheet 的测试点合并 |
| ⑧ | 游离主题 | detached 被跳过 |
| ⑨ | 老版本 XML | xmind 8 content.xml 也能解析 |
| ⑩ | 非法文件 | 非 zip → 返回 errorMsg |

## 7. 依赖清单变更

- `dependencies` 新增：`jszip ^3.10.1`
- 无新增 devDependency（`jszip` 自带 TS 类型声明）

## 8. 未纳入的能力（可扩展点）

- **备注（notes）作为说明**：目前说明节点被完全忽略，若未来希望把测试点节点的 `notes` 拼进 caseDetail，可在 `zenTopicToNode` / XML 解析里追加读取，`XmindNode` 结构上加 `notes?: string` 字段。
- **XMind AI 生成的图标**：若团队开始使用 XMind AI 自定义图标（如 `custom-xxx`），需扩展 marker 白名单前缀。
- **附件 / 图片 / 链接**：xmind zip 里还可能包含 `attachments/`、`resources/`、`hyperlink`，本 parser 全部忽略。

## 9. 变更影响面

| 层 | 影响 | 备注 |
|---|---|---|
| 数据模型 | 无变动 | 沿用 `PointItem`；envelope 新增两个可选字段 |
| 匹配引擎 (`pointCaseLinker.ts`) | 无变动 | pointList 结构完全同构 |
| md 解析器 (`parseMdToPointListSilent`) | 无变动 | 完全隔离 |
| handler | `getLinkedCasesByMdFile` + `handleLinkerDiagnostic` 里的扩展名校验放开为 md/xmind；新增 Output Channel 追加函数 |
| package.json | 新增 `jszip` 依赖 |
| 单测 | 新增 1 个测试文件（10 个用例，全绿） |
