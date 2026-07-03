## 案例编辑器（table-editor webview）增删改查埋点

> 目标：把用户在表格里的「增、删、改、查」行为全部纳入埋点，覆盖到每一次单元格操作。
> 当前缺口：webview 侧完全没有埋点，后端只覆盖了 push/save/open/外部变更。
> 状态：📌 待实现

### 1. 基础设施（一次性，先做）

- [ ] **extension 侧**：在 `src/providers/BaseEditorProvider.ts` 的 `onDidReceiveMessage` 增加 `case 'telemetry'` 分支
  - 字段：`{ type: 'telemetry', event, level?, props?, measures? }`
  - 强制 `sanitizeProps`：value→string、单字段截断 200 字符、剔除 `path/content/text/value/keyword` 等可能含 PII 的字段
  - 路由：`level==='error'` → `sendTelemetryErrorEvent`；其他 → `sendTelemetryEvent`
- [ ] **webview 侧**：在 `media/pages/table-editor/editor/01-core.js` 注册全局 `S.track(event, props, level)`
  - 内部 try/catch，确保任何异常不影响业务
  - 同步加节流工具 `S.trackThrottled(event, key, props, waitMs=500)`，用于 `cell.edit / column.resize / find.exec` 等高频事件

### 2. 事件清单（统一 `editor.*` namespace）

| 大类 | event | 关键 props（已脱敏） | 触发位置 |
|---|---|---|---|
| 改 | `editor.cell.edit` | `col`, `source`(inline/modal/paste/fill), `valueLen`, `fileFormat` | `03a-cell-edit.js` |
| 改 | `editor.cells.fill` | `cellCount`, `rows`, `cols`, `fileFormat` | `03a-cell-edit.js` |
| 改 | `editor.undo` | `fileFormat` | `03a-cell-edit.js` |
| 改 | `editor.redo` | `fileFormat` | `03a-cell-edit.js` |
| 增 | `editor.row.add` | `position`(top/below/bottom), `count`, `fileFormat` | `02b-bind.js` |
| 增 | `editor.row.duplicate` | `count`, `fileFormat` | `02b-bind.js` |
| 增 | `editor.column.add` | `name`(截断), `fileFormat` | `02b-bind.js` |
| 删 | `editor.row.delete` | `count`, `fileFormat` | `02b-bind.js` |
| 删 | `editor.column.delete` | `fileFormat` | `02b-bind.js` |
| 删 | `editor.cell.clear` | `cellCount`, `fileFormat` | `03a-cell-edit.js` |
| 查 | `editor.find.exec` | `hasResults`, `matchCount`, `regex`, `caseSensitive` | `04-push-find.js` |
| 查 | `editor.replace.exec` | `replacedCount`, `mode`(one/all) | `04-push-find.js` |
| 查 | `editor.filter.toggle` | `col`, `state`(on/off) | `02a-render.js` |
| 查 | `editor.sort.apply` | `col`, `dir`(asc/desc) | `02a-render.js` |
| 查 | `editor.column.resize` | `col`, `fileFormat` | `02a-render.js` |
| 查 | `editor.cell.detail.open` | `col`, `fileFormat` | `05-modals.js` |
| 导出 | `editor.selection.copy` | `cellCount`, `fileFormat` | `02b-bind.js` |

### 3. 高频事件防护

- [ ] `editor.cell.edit`：500ms 节流，同 col 合并为一次（带 `count`）
- [ ] `editor.column.resize`：300ms 防抖，只在拖拽结束上报
- [ ] `editor.find.exec`：输入框 stop typing 后 500ms 上报
- [ ] 单文件单次会话 `editor.cell.edit` 累计 200 次后只报计数，不展开 props

### 4. 隐私红线（已与现网规范一致）

- ❌ 永不上报：单元格内容、文件路径、文件名、查找关键字、替换文本
- ✅ 只上报：列 key、行/单元格数量、操作来源、长度、布尔标志

### 5. 改动文件预估

- `src/providers/BaseEditorProvider.ts`（+30 行：telemetry 通道 + sanitize）
- `media/pages/table-editor/editor/01-core.js`（+25 行：S.track / 节流）
- `media/pages/table-editor/editor/03a-cell-edit.js`（+15 行）
- `media/pages/table-editor/editor/02a-render.js`（+10 行）
- `media/pages/table-editor/editor/02b-bind.js`（+15 行）
- `media/pages/table-editor/editor/04-push-find.js`（+10 行）
- `media/pages/table-editor/editor/05-modals.js`（+10 行）
- `埋点事件清单.md`（新增第七章「编辑器交互埋点」）

### 6. 待用户确认的开放问题

- [ ] 范围：本期是 17 个事件全做，还是先做"增/删/改"、暂缓"查"？
- [ ] 节流：`editor.cell.edit` 是否接受 500ms 节流（避免逐字符上报）？
- [ ] 封顶：单文件会话内 `editor.cell.edit` 是否封顶 200 次？
