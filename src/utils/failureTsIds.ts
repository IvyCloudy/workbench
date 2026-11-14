/**
 * 05g 文件级伪分组键（后端唯一来源）。
 *
 * 该 tsId 不对应任何真实案例行，仅用于把「缺必备列」等文件级问题聚合到同一张卡片。
 * 前端 media/pages/table-editor/editor/05g-pre-validate-gate.js 因跨语言无法直接 import，
 * 保有同值常量；由 src/test/preValidateShared.test.ts 的契约测试守护，改名必须两边同步。
 */
export const FILE_LEVEL_TSID = '__FILE_LEVEL__';
