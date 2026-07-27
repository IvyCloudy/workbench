# 测试要点 ↔ 测试案例 关联匹配 — 需求文档

> 模块名：`pointCaseLinker`
> 交付形态：TypeScript 公共方法
> 文件位置：`src/utils/pointCaseLinker.ts`
> 单测位置：`src/test/pointCaseLinker.test.ts`

---

## 一、需求背景

在测试大纲编写与测试案例落地的过程中，团队存在两份并行数据：

- **测试要点文件**（Markdown / XMind）：由测试架构师编写，用来描述"测什么"，每条测试点携带 **序号（pointId）**、**测试点名称（pointName）**、**路径（pointPath，形如"功能条目/测试要点"）**。
- **测试案例文件**（YAML / JSON / CSV）：由用例工程师编写，用来描述"怎么测"，案例通过 **parent_id** 字段回指其所属的测试要点序号，同时可能带一个 **path** 字段冗余保存所属路径。

用户在使用可视化插件浏览测试要点时，需要即时看到"这个测试点当前有哪些案例覆盖"，反过来在案例文件里也需要看到"这条案例挂在哪个测试点下"。两份数据分散在不同类型的文件中，且案例的 `parent_id` 存在多种不规范写法（数组、逗号分隔、末尾拼接子序号 `-1/-2`），需要一个高性能、可复用的公共方法把二者关联起来，并对外提供稳定的分组结构与反查索引。

---

## 二、需求目的

围绕"测试要点 → 测试案例"的关联匹配场景，提供一个 **纯计算、可缓存、可批量** 的公共方法：

1. **一次调用完成关联**：给定测试要点清单 + 一个或多个案例文件路径，返回按测试点分组的案例列表，供上层直接消费。
2. **匹配质量可分档**：不是所有案例的关联都同样可靠——`parent_id` 精确命中且 `path` 也对得上 是最强证据；只对上 `parent_id` 略弱；只对上 `path` 最弱。方法需要把匹配强度以 `type` 字段明确标出来，UI 层可以据此展示不同的置信度提示。
3. **兼容脏数据**：`parent_id` 可能是 `["A", "B"]`、`"A;B"`、`"A-1"` 等各种形态，方法需要在不改动原始数据的前提下把它们归一化后再匹配。
4. **性能可控**：即便测试要点数以百计、案例记录数以万计，也应在毫秒级完成匹配；重复调用同一个文件不应重复解析。
5. **可观测**：脏数据（重复的 pointId、同一 case 命中多个 point、路径归一化失败等）需要以埋点与统计字段暴露出来，便于后续治理。

---

## 三、功能清单

### 3.1 单文件关联匹配

#### 功能简述

调用方传入 **一个案例文件** 的绝对路径与 **一个测试要点清单**，方法读取案例文件、逐条与要点清单比对，产出"点 → 案例"分组结果与反向索引。

#### 输入参数

| 参数 | 类型 | 是否必填 | 说明 |
|------|------|---------|------|
| `filePath` | string | 是 | 案例文件绝对路径，支持 `.yaml` / `.json` / `.csv` |
| `pointList` | 数组，见下 | 是 | 测试要点清单（可能是多个 md 文件合并后的结果） |
| `options` | 对象 | 否 | 见 3.4 节 |

**`pointList` 单项结构**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `pointId` | string | 测试要点序号，如 `LGN-001` |
| `pointName` | string | 测试要点名称，如 `账号密码登录` |
| `pointPath` | string | 测试要点路径，形如 `账户中心/登录模块` |

#### 输出结果

返回对象包含三部分：

**① `byPoint`：主索引（点 → 案例列表）**

- Key 格式：`${pointId}_${pointName}`
- Value：该点下命中的案例数组，每项字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `testcase_id` | string | 案例唯一 ID，作为 UI 端的 node_id |
| `caseName` | string | 案例名称 |
| `caseDetail` | string | `【前置条件】xxx 【预期结果】yyy` 拼接文本，空段自动省略 |
| `type` | 1 \| 2 \| 3 | 匹配类型，见 3.2 节 |

**② `byCase`：反向索引（案例 → 点）**

- Key：`testcase_id`
- Value：`{ pointKey: string, type: 1 | 2 | 3 }`
- 用途：从案例反查所属点，O(1) 复杂度，供 UI 端"案例查所属要点"的场景使用。

**③ `stats`：统计信息**

| 字段 | 类型 | 说明 |
|------|------|------|
| `totalRecords` | number | 案例文件读取到的总记录数 |
| `matchedRecords` | number | 成功归到某个点下的案例数 |
| `orphanRecords` | number | `parent_id` 与 `path` 均无法命中任何点的孤儿案例数 |
| `matchedByType.type1` | number | 强关联（parent_id + path 双命中）案例数 |
| `matchedByType.type2` | number | 仅 path 命中案例数 |
| `matchedByType.type3` | number | 仅 parent_id 命中案例数 |
| `duplicatePointIds` | string[] | 传入的 pointList 中存在同名 pointId 的列表 |
| `multiHitCases` | string[] | 同一案例同时命中多个不同点（脏数据兜底触发）的 testcase_id 列表 |
| `strippedParentIds` | number | 因末尾 `-数字` 被剥离后才成功命中的案例数（用于观测数据质量） |

---

### 3.2 匹配类型分档

同一条案例的匹配质量分为三档，`type` 字段的取值含义如下：

| type | 命中条件 | 匹配强度 | 典型场景 |
|------|---------|---------|---------|
| **1** | `parent_id` 命中 **且** 归一化后的 `path` 与要点的 `pointPath` 相等 | **最强** | 案例撰写规范，双字段都对得上 |
| **2** | 仅归一化后的 `path` 命中（`parent_id` 缺失或写错） | 中等 | 序号丢失时的兜底匹配 |
| **3** | 仅 `parent_id` 命中（`path` 缺失或与要点路径不一致） | 最弱 | 案例迁移过程中路径尚未同步 |

**优先级规则**：`type=1 > type=2 > type=3`（数值越小越可靠）。同一案例在候选点集合中，最终归属选取 **type 值最小的那个点**。

**path 命中的兜底语义**（重要）：

- 只要案例的 `parent_id` 命中了任何一个点（无论 path 是否也匹配），归属选取只在 `parent_id` 候选集合内做，`path` 不再引入额外的候选点。
- 当且仅当 `parent_id` 完全无法命中任何点（缺失、写错、剥离后仍失败）时，`path` 匹配才作为最后一档兜底，产生 `type=2`。
- 这样可以避免

---

### 3.3 数据归一化规则

#### 3.3.1 parent_id 归一化

案例文件里 `parent_id` 字段实际可能出现以下形态，方法均需正确处理：

| 形态 | 示例 | 处理规则 |
|------|------|---------|
| 单值 | `"LGN-001"` | 直接使用 |
| 数组 | `["LGN-001", "ORD-001"]` | 每一项独立参与匹配（相当于该案例被声明属于多个点） |
| 逗号分隔 | `"LGN-001,ORD-001"` | 按 `,` 拆分为多值 |
| 分号分隔 | `"LGN-001;ORD-001"` | 按 `;` 拆分为多值 |
| 中文分隔 | `"LGN-001，ORD-001"` / `"LGN-001；ORD-001"` | 同样拆分 |
| 末尾拼接子序号 | `"LGN-001-1"` / `"LGN-002-12"` | 见下方"末尾剥离"规则 |
| 空值 | `null` / `""` | 该案例不通过 parent_id 匹配（仍可通过 path 匹配为 type=2） |

**末尾 `-数字` 剥离规则**（默认开启，可关）：

- 先用原始值 `LGN-001-1` 到点索引里查询；
- **查不到时** 才尝试剥离末尾 `-1`，用 `LGN-001` 再查一次；
- 这样能规避把 `LGN-001` 本身误当成"LGN 加了子序号 001"的错剥问题；
- 每一次成功剥离都会累加 `stats.strippedParentIds`，便于观测数据质量。

#### 3.3.2 path 归一化

`pointPath` 与案例的 `path` 字段在真实数据里存在多种"看起来一样、字符不同"的情况，方法内部会将两侧统一处理后再比对：

| 归一化步骤 | 示例输入 | 输出 |
|-----------|---------|------|
| 首尾空白裁剪 | `" 账户中心/登录模块 "` | `"账户中心/登录模块"` |
| 统一分隔符 | `"账户中心\\登录模块"`、`"账户中心／登录模块"`、`"账户中心·登录模块"` | 一律转为 `"账户中心/登录模块"` |
| 折叠内部空白 | `"账户中心  登录模块"` | `"账户中心 登录模块"` |
| 去除斜杠两侧空白 | `"账户中心 / 登录模块"` | `"账户中心/登录模块"` |
| 合并连续斜杠 | `"账户中心//登录模块"` | `"账户中心/登录模块"` |
| 去掉首尾斜杠 | `"/账户中心/登录模块/"` | `"账户中心/登录模块"` |

> **说明**：归一化不改变原始数据，仅在匹配比对时使用。归一化后的空串视为"无路径"，不参与 path 命中。

---

### 3.4 可选配置项（LinkOptions）

| 配置项 | 类型 | 默认值 | 说明 |
|-------|------|-------|------|
| `parentIdField` | string | `"parent_id"` | 案例记录里"父点 ID"字段名 |
| `pathField` | string | `"path"` | 案例记录里"路径"字段名 |
| `caseIdField` | string | `"testcase_id"` | 案例记录里"唯一 ID"字段名 |
| `caseNameField` | string | `"name"` | 案例记录里"名称"字段名 |
| `preconditionFields` | string[] | `["preconditions", "preCondition", "pre_condition"]` | "前置条件"候选字段，按顺序取第一个非空 |
| `expectedFields` | string[] | `["expected", "expectedResult", "ui_expected", "api_expected", "db_expected"]` | "预期结果"候选字段，命中的会用换行拼接 |
| `stripParentIdTailIndex` | boolean | `true` | 是否在原值查不到时尝试剥离末尾 `-数字` |
| `enableCache` | boolean | `true` | 是否启用文件解析结果缓存 |
| `telemetry` | boolean | `true` | 是否打埋点 |

---

### 3.5 批量关联匹配（多文件）

#### 功能简述

当需要一次性将测试要点清单与多个案例文件建立关联时（例如一个测试大纲对应多个 YAML 案例文件），提供批量入口 `linkPointsToCasesBatch`，一次构建索引，多次匹配，同时以受控并发解析文件。

#### 输入参数

| 参数 | 说明 |
|------|------|
| `filePaths` | 案例文件路径数组 |
| `pointList` | 同 3.1 |
| `options` | 在 `LinkOptions` 基础上额外支持 `concurrency`（并发度），默认 `4` |

#### 输出结果

返回 `Record<filePath, LinkResult>`，即"文件路径 → 单文件结果"的映射。

#### 关键行为

- **索引复用**：pointList 索引只在整个批次开头构建一次，避免 N 次重复建索引。
- **并发解析**：文件解析（IO 密集）按 `concurrency` 并发进行，默认 4。
- **单文件失败隔离**：任何一个文件解析失败，返回该文件对应的空结果 + 埋点错误事件，不影响其他文件。

---

### 3.6 边界与异常场景

| 场景 | 方法行为 |
|------|---------|
| `filePath` 为空串或 `undefined` | 直接抛错 `linkPointsToCases: filePath 不能为空` |
| `pointList` 为空数组 | 返回空的 `byPoint` / `byCase`，`stats` 全部归零 |
| `pointList` 中同一 pointId 重复出现 | 全部保留（合并多归属），并在 `stats.duplicatePointIds` 中列出 |
| 同一案例 `parent_id` 数组里指向不同的点 | 归到 type 最强的那个点；其他点自动放弃；记入 `stats.multiHitCases` |
| 案例 `parent_id` 命中 A、但 `path` 又指向了完全不同模块的 B | 归到 A（parent_id 优先）；同时 `path` 与 `parent_id` 归属完全不相交视为数据自打架，记入 `stats.multiHitCases` |
| 案例 `parent_id` 命中 A，`path` 匹配的点集合中也包含 A（只是同 `pointPath` 下还有兄弟点）| 归到 A；**不**记入 multiHit（属正常场景） |
| 案例 `parent_id` 是脏值（含空格、大小写混杂） | 空格 trim 后使用；大小写不做归一化（严格匹配） |
| 案例文件读取失败 | 单文件入口抛出原始错误；批量入口该文件返回空结果 + 打点 `pointCaseLinker.fileError` |
| 同一点下多条 `testcase_id` 完全相同的案例 | 后续同 ID 自动去重（Set 语义） |

---

### 3.7 性能与缓存

#### 时间复杂度

| 阶段 | 复杂度 |
|------|-------|
| 索引构建 | O(P)，P 为 pointList 长度 |
| 匹配 | O(C × k)，C 为案例记录数，k 为每记录 `parent_id` 的多值数量（多数为 1） |
| 总体 | **O(P + C × k)**，无嵌套遍历 |

#### 缓存策略

- 使用模块级 **LRU 缓存**（容量 64）保存"文件路径 → 已解析记录数组"；
- 缓存键：文件路径 + mtimeMs + size；文件被修改时缓存自动失效；
- 提供 `clearLinkerCache()` 手动清空入口，供测试或热更新使用；
- 缓存对调用方透明，`options.enableCache` 可关闭（默认开）。

#### 参考性能

| 场景 | 期望耗时（热调用） |
|------|-----------------|
| P=50, C=200 | < 1 ms |
| P=200, C=2000 | < 5 ms |
| P=1000, C=10000 | < 30 ms |

（以上不含首次文件解析的 IO 耗时。）

---

### 3.8 埋点事件

事件通过 `TelemetryService` 上报，可通过 `options.telemetry: false` 关闭。

| 事件名 | 触发时机 | 关键字段 |
|-------|---------|---------|
| `pointCaseLinker.done` | 每次匹配完成 | `fileExt` / `pointCount` / `totalRecords` / `matchedRecords` / `orphanRecords` / `type1` / `type2` / `type3` / `strippedParentIds` |
| `pointCaseLinker.duplicatePointId` | pointList 存在重复 pointId | `fileExt` / `dupCount` |
| `pointCaseLinker.multiHitCase` | 存在案例被同时归到多个点 | `fileExt` / `caseCount` |
| `pointCaseLinker.fileError` | 批量入口下单文件解析失败 | `fileExt` / `errorMessage`（截断至 200 字符） |

---

### 3.9 对外导出的工具函数

除了两个主入口，模块还导出若干纯函数，供其他模块直接复用：

| 函数 | 用途 |
|------|-----|
| `normalizePointPath(p)` | 与匹配算法一致的路径归一化，UI 端展示前的对齐处理可复用 |
| `normalizeParentIds(v)` | 将 `parent_id` 归一化为 `string[]`，可用于校验/清洗脚本 |
| `stripSubIndex(pid)` | 剥离末尾 `-数字`，独立工具场景可复用 |
| `clearLinkerCache()` | 清空文件缓存 |

---

## 四、输入输出示例

### 4.1 输入

```jsonc
// filePath = "/path/to/case.yaml"
// 文件内容（YAML → 解析后）：
[
  {
    "testcase_id": "C-100",
    "parent_id": "LGN-001",
    "path": "账户中心/登录模块",
    "name": "账号密码登录_成功",
    "preconditions": ["用户已注册"],
    "expected": "登录成功"
  },
  {
    "testcase_id": "C-101",
    "parent_id": "LGN-001-1",   // 末尾拼接子序号
    "path": "账户中心/登录模块",
    "name": "账号密码登录_密码错误",
    "expected": "提示密码错误"
  },
  {
    "testcase_id": "C-999",
    "parent_id": "UNKNOWN-X",
    "path": "未知模块/未知",
    "name": "orphan"
  }
]

// pointList：
[
  { "pointId": "LGN-001", "pointName": "账号密码登录", "pointPath": "账户中心/登录模块" }
]
```

### 4.2 输出

```jsonc
{
  "byPoint": {
    "LGN-001_账号密码登录": [
      {
        "testcase_id": "C-100",
        "caseName": "账号密码登录_成功",
        "caseDetail": "【前置条件】用户已注册 【预期结果】登录成功",
        "type": 1
      },
      {
        "testcase_id": "C-101",
        "caseName": "账号密码登录_密码错误",
        "caseDetail": "【预期结果】提示密码错误",
        "type": 1
      }
    ]
  },
  "byCase": {
    "C-100": { "pointKey": "LGN-001_账号密码登录", "type": 1 },
    "C-101": { "pointKey": "LGN-001_账号密码登录", "type": 1 }
  },
  "stats": {
    "totalRecords": 3,
    "matchedRecords": 2,
    "orphanRecords": 1,
    "matchedByType": { "type1": 2, "type2": 0, "type3": 0 },
    "duplicatePointIds": [],
    "multiHitCases": [],
    "strippedParentIds": 1
  }
}
```

---

## 五、API 参考

### 5.1 单文件入口

```ts
export async function linkPointsToCases(
  filePath: string,
  pointList: PointItem[],
  options?: LinkOptions,
): Promise<LinkResult>;
```

### 5.2 批量入口

```ts
export async function linkPointsToCasesBatch(
  filePaths: string[],
  pointList: PointItem[],
  options?: LinkOptions & { concurrency?: number },
): Promise<Record<string, LinkResult>>;
```

### 5.3 类型定义

```ts
export interface PointItem {
  pointId: string;
  pointName: string;
  pointPath: string;
}

export interface CaseItem {
  testcase_id: string;
  caseName: string;
  caseDetail: string;   // 【前置条件】... 【预期结果】...
  type: 1 | 2 | 3;      // 1: parent_id+path；2: 仅 path；3: 仅 parent_id
}

export interface LinkResult {
  byPoint: Record<string, CaseItem[]>;    // key: `${pointId}_${pointName}`
  byCase: Record<string, { pointKey: string; type: 1 | 2 | 3 }>;
  stats: {
    totalRecords: number;
    matchedRecords: number;
    orphanRecords: number;
    matchedByType: { type1: number; type2: number; type3: number };
    duplicatePointIds: string[];
    multiHitCases: string[];
    strippedParentIds: number;
  };
}
```

---

## 六、测试覆盖清单

单元测试位于 [`src/test/pointCaseLinker.test.ts`](../../src/test/pointCaseLinker.test.ts)，覆盖以下 **19 个用例**：

| 编号 | 用例 |
|------|------|
| 1 | 基本匹配 · type=1（parent_id + path 双命中） |
| 2 | 基本匹配 · type=3（path 不等） |
| 3 | 基本匹配 · type=3（path 缺失） |
| 4 | 基本匹配 · type=2（仅 path） |
| 5 | 孤儿记录 · parent_id 和 path 都匹配不上 |
| 6 | parent_id 数组 · 多归属拆分 + Q14 多命中兜底 |
| 7 | parent_id 分隔字符串 · `LGN-001;ORD-001` |
| 8 | parent_id 尾号剥离 · `LGN-001-1` → `LGN-001` |
| 9 | parent_id 尾号剥离关闭 · 无法命中 fallback |
| 10 | path 归一化 · 分隔符/首尾斜杠/连续空白 均视为相等 |
| 11 | 一对多 · 同一 point 下多个 case |
| 12 | 同 point 内 testcase_id 相同 · 去重 |
| 13 | multiHit · case 命中多个不同 point 只留最强 |
| 14 | 空 pointList · 返回空结果 |
| 15 | filePath 为空 · 抛错 |
| 16 | caseDetail · 【前置条件】+【预期结果】拼接（数组用换行连接） |
| 17 | linkPointsToCasesBatch · 多文件并发匹配 |
| 18 | pointList 内重复 pointId · 记入 duplicatePointIds |
| 19 | 缓存命中 · 连续两次调用只解析一次 |

---

## 七、非功能要求

| 项 | 要求 |
|---|------|
| 依赖 | 仅依赖项目内 `parsers.parseFileToRows` / `TelemetryService` / `createLogger`，不引入新的三方库 |
| TypeScript | strict 模式下 0 编译错误 |
| Lint | 0 warning |
| 测试通过率 | 100%（自有 19 项 + 存量全部通过） |
| 副作用 | 纯计算 + 只读文件；不修改任何案例文件或要点文件 |
| 线程安全 | 单进程内共享 LRU 缓存，读写路径已保证一致性；对外接口幂等 |

---

## 八、后续演进方向（非本期）

1. **反向入口**：以案例文件为起点、给定案例路径清单，反查要点文件（当前 md/xmind 侧解析尚未标准化，暂不实现）。
2. **模糊匹配**：pointName 与案例名的相似度打分，用于兜底补救（需要引入编辑距离算法）。
3. **持久化索引**：对超大项目（P > 10000）落地磁盘索引文件，避免每次冷启动重建；当前规模下无需。
4. **并发度自适应**：根据 CPU 核数与文件数量动态调整批量入口的并发度；当前固定默认 4。
