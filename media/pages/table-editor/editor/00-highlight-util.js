/**
 * ============================================================================
 *  00-highlight-util.js —— barrel 注释文件（内容已拆分，2026-09-19 · 方案 C · C6）
 * ----------------------------------------------------------------------------
 *  本文件原本承载 1186 行的高亮工具/门面实现，现已拆分为 3 个子模块，
 *  位于同目录下的 highlight/ 子文件夹：
 *
 *    · highlight/00a-highlight-util.js
 *        —— FIELD_TO_HEADER_KEYS / FIELD_SUB_TO_XSE_SECTION 常量
 *        —— resolveFieldColumnIndex / getFailedColumnsOfRow / getFieldSeverityOfColumn
 *        —— getFailedStepCellsOfRow / isRowColFullyGranular
 *        —— parseHighlightedCells / resolveHighlight
 *        —— 首次装配 window.HighlightUtil 与 window.HighlightModel（字段码查询接口）
 *
 *    · highlight/00b-highlight-model-write.js
 *        —— setHighlightedCells / setAddedRows / addAddedRow / shiftRowIndex
 *        —— resetForReload / resetForFullPush / resetAllHighlights / resetOnColumnChange
 *        —— clearByPushBatch
 *        —— 通过 Object.assign 追加到 window.HighlightModel
 *
 *    · highlight/00c-highlight-model-snap.js
 *        —— _clonePushFailures / _cloneMarkRects / _invalidateUserMarksCache（内敛）
 *        —— snapshotForUndo / restoreFromSnapshot
 *        —— applyPushFailuresPayload / applyUserMarksPayload
 *        —— 通过 Object.assign 追加到 window.HighlightModel
 *
 *  加载顺序（由 src/providers/BaseEditorProvider.ts 控制）：
 *      highlight/00a → highlight/00b → highlight/00c
 *  其余 01~05x 前端脚本对 window.HighlightUtil / window.HighlightModel 的
 *  访问路径 100% 保持不变。
 *
 *  本文件已从 webview script 加载列表中移除，仅作为 grep/文档索引存根保留：
 *  docs/specs/高亮逻辑说明.md、若干 CSV 用例测试文件以及数个前端注释仍在按
 *  名字引用 "00-highlight-util.js"，保留一个薄注释文件避免引用失效。
 * ============================================================================
 */
