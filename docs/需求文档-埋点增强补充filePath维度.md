# 埋点增强：全链路遥测事件补充 filePath 维度

- **文档类型**：需求文档（遥测可观测性增强，用户视角）
- **创建日期**：2026-10-16
- **状态**：已实现（代码改动待提交）

---

## 0. 概述

本文档描述一项横切的遥测（埋点）可观测性增强：在案例编辑器与推送链路上的遥测事件里，统一补充 `filePath`（仅文件名 basename，按遥测规范脱敏，不上报绝对路径）维度，使研发能够在遥测后台按"文件"维度聚合与定位问题。

该增强**不改变任何业务功能与用户行为**，仅扩充埋点上报字段，便于线上按文件名定位高频出错的具体文件（如某个 csv 反复解析失败、某个 yaml 推送频繁超时），减少依赖用户手动反馈截图。

涉及范围（横切，不影响业务逻辑）：

- 编辑器生命周期事件（`editor.opened` / `saved` / `switchedToText` / `reloaded` / 各类 error 等）；
- 推送链路公共埋点字段（`baseTelemetryProps`）；
- 三个解析器的解析失败事件（`parser.parseFailed`）；
- 编辑器提供器、文件监控、webview 数据推送的各类事件。

---

## 1. 背景与用户场景

现有遥测事件多以 `fileFormat`（csv / json / yaml）等维度为主，缺少"文件名"维度，线上聚合时无法区分"是哪个文件"出的问题：

- R10 已为 `parser.parseFailed` 补充了 `fileName` 维度，但编辑器打开、保存、推送、切文本、删除案例、外部变更、testcase_id 落盘等大量事件仍只有 `fileFormat`，缺文件名维度，难以定位高频出错的具体文件。
- 研发排障时只能靠用户手动反馈截图，无法在遥测后台直接按文件聚合失败分布。

用户视角的诉求：

- 线上某个文件反复出问题（解析失败 / 推送超时 / 落盘失败），希望后台能直接按文件名聚合出"哪些文件最常出错"，而不是笼统地看格式维度。
- 不希望上报绝对路径（含目录与用户名），避免 PII 泄露；仅文件名即可满足按文件定位的需要。

---

## 2. 需求

1. 在所有关键遥测事件（`TelemetryService` 上报）中补充 `filePath` 字段，取值为 `path.basename(filePath)`，仅文件名、不含目录与绝对路径，符合脱敏约定。
2. 涉及事件至少包含：
   - **编辑器**：`editor.opened`、`editor.saved`、`editor.switchedToText`、`editor.reloaded`、`editor.deleteRows.error`、`editor.message.error`、`editor.save.error`、`editor.push.error`、`editor.network.error`；
   - **推送链路公共字段**（通过 `baseTelemetryProps` 统一注入）：在 `ext`、`traceId` 之外新增 `filePath: ctx.baseName`；
   - **解析器**：`parser.parseFailed`（csv / json / yaml）追加 `filePath`；
   - **编辑器提供器**：`editor.waitReady.timeout`、`editor.keepEditor.failed`、`editor.opened.tempFolder`、`editor.opened.unqualified`、`editor.visibleChange.skipped`、`editor.visibleChange.failed`、`editorPush.reparseFailed`；
   - **文件监控**：`editor.externalChange.skipped`、`editor.externalChange.fired`；
   - **webview 数据推送**：`editor.testcaseId.saveFailed`。
3. 埋点须遵循既有 `TelemetryService` 约定：受 VS Code 遥测开关控制、开发环境仅本地打印不上报、单事件 payload ≤ 8KB、不影响主流程（埋点失败静默丢弃）。
4. 脱敏约束：路径 / 文件名相关字段仅传 basename，不上报绝对路径，避免 PII（与 R10 一致）。

---

## 3. 使用预期

- **线上**：遥测后台可按 `filePath` 维度聚合，定位高频出错的具体文件（如某个 csv 反复解析失败、某个 yaml 推送频繁超时），无需依赖用户手动反馈。
- **本地开发**：受 VS Code 遥测开关控制，仅本地打印，不上报。
- **业务行为零变化**：仅埋点字段扩充，不影响任何功能逻辑、不新增或改变弹窗与交互。

---

## 4. 补充说明（已确认方案与约束）

- **实现位置**（均为在原有 `TelemetryService.sendTelemetryEvent/ErrorEvent` 调用处追加 `filePath: path.basename(...)`，或对推送链路公共字段函数 `baseTelemetryProps` 增加 `filePath: ctx.baseName`）：
  - `src/handlers/editorMessageHandlers.ts`：多个 `editor.*` 事件补 `filePath`；
  - `src/handlers/pushCore.stages.ts`、`src/handlers/pushCore.ts`、`src/preValidate/stepPreValidate.ts`：各自的 `baseTelemetryProps` 公共字段加 `filePath: ctx.baseName`；
  - `src/parsers/csv-parser.ts`、`src/parsers/json-parser.ts`、`src/parsers/yaml-parser.ts`：`parser.parseFailed` 补 `filePath`；
  - `src/providers/BaseEditorProvider.ts`：多个 `editor.*` 事件补 `filePath`；
  - `src/services/fileWatchService.ts`：`editor.externalChange.skipped` / `fired` 补 `filePath`；
  - `src/services/webviewDataPusher.ts`：`editor.testcaseId.saveFailed` 补 `filePath`。
- **与 R10 的关系**：R10 为 `parser.parseFailed` 新增了 `fileName` 维度；本需求在此基础上为同一事件补充 `filePath`（basename，二者取值一致，均为文件名），并横向扩展到编辑器 / 推送 / 监控等全链路事件，统一补齐按文件定位的能力。
- **与埋点契约**：事件名 / 字段遵循 `docs/specs/埋点事件清单.md`；新增的 `filePath` 维度需在该清单中登记说明（与既有 `fileName` 并列，标注取值为 basename）。
- **影响面控制**：纯字段扩充，无新增埋点事件、无逻辑分支变化，对主流程无副作用；与现有埋点脱敏、开关、上报约束完全兼容。
