# TestCase Viewer

> VS Code 扩展：测试案例可视化查看与编辑器

| 字段 | 值 |
| --- | --- |
| 包名 | `testcase-viewer` |
| 当前版本 | `0.0.1` |
| VS Code 引擎要求 | `^1.84.0` |
| 入口 | `./out/extension.js` |

---

## ✨ 主要特性

- 📋 **表格编辑器**：YAML/JSON/CSV 三态同步的测试案例表格视图，支持单元格编辑、批量操作、行高自适应、列宽调整、冻结、过滤、查找替换、合并粘贴等
- 🌳 **思维导图视图**：测试案例脑图化展示（mindmap）
- ⚡ **推送/绑定**：推送本地案例到远端、与 TAPD/Track 任务绑定
- 🏷 **标记 & 撤销栈**：单元格标记（颜色/字体颜色）支持完整的 undo/redo 历史
- 🔍 **删除/新增/修改追踪**：每行的修改、新增、删除、推送失败等状态独立可视化与过滤
- 🌐 **中英表头映射**：支持配置化的中文表头展示

> 完整功能列表请见 [`docs/guides/插件功能清单.md`](docs/guides/插件功能清单.md)。

---

## 🚀 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 编译
npm run compile

# 3. 在 VS Code 中按 F5 启动 Extension Development Host 调试
```

更详细的依赖与环境说明：[`docs/guides/依赖安装说明.md`](docs/guides/依赖安装说明.md)

---

## 📂 项目结构（顶层）

```
.
├── src/                # 扩展端 TypeScript 源码（providers / services / utils）
├── media/              # WebView 前端资源（table-editor、mindmap）
├── out/                # 编译产物（git ignored）
├── docs/               # 项目文档（按主题归档）
│   ├── guides/         # 用户与开发指南
│   ├── specs/          # 规格 / 约定
│   ├── architecture/   # 架构与项目总览
│   └── history/        # 历史阶段性总结（仅供回溯）
├── package.json
└── tsconfig.json
```

---

## 📚 文档导航

| 主题 | 文档 |
| --- | --- |
| 🏛 项目总览 | [项目说明文档](docs/architecture/项目说明文档.md) |
| 📖 表格编辑器使用 | [测试案例编辑器操作文档](docs/guides/测试案例编辑器操作文档.md) |
| 🚀 推送案例 | [案例推送操作指引](docs/guides/案例推送操作指引.md) |
| 📋 功能清单 | [插件功能清单](docs/guides/插件功能清单.md) |
| 💬 消息工具 | [message 使用指南](docs/guides/message-使用指南.md) |
| ⚙️ 依赖安装 | [依赖安装说明](docs/guides/依赖安装说明.md) |
| 📑 CSV 目录结构 | [csv目录结构](docs/specs/csv目录结构.md) |
| 🔤 表头中英映射 | [表头中英映射说明](docs/specs/表头中英映射说明.md) |
| 📊 埋点事件 | [埋点事件清单](docs/specs/埋点事件清单.md) |

> 完整索引：[docs/README.md](docs/README.md)

---

## 🛠 NPM Scripts

| Script | 说明 |
| --- | --- |
| `npm run compile` | TypeScript 编译到 `out/` |
| `npm run watch` | 监听编译 |
| `npm test` | 运行扩展端单元测试 |
| `npm run test:watch` | 监听测试 |

---

## 🤝 贡献

提交前请确保 `npm run compile` 通过；新增/调整功能请同步更新对应文档（位于 `docs/`）。


