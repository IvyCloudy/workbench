/**
 * ============================================================================
 *  preValidate/csvRowAdapter.ts
 *  CSV parser 输出 → RowLike[] 统一组装器（P4 · 性能优化 2026-09-19）
 * ----------------------------------------------------------------------------
 *  背景：
 *    CSV parser 的 sourceData 恒为 null（见 csv-parser.ts 实现），
 *    需从 tableData.headers + tableData.rows 组装以中文列名为 key 的对象数组，
 *    与 ENUM_VALIDATOR 的 csvKey（如「案例类型」「执行方式」）严格对齐，行级校验才能生效。
 *
 *  重复代码问题：
 *    · editValidationHandler._doValidate 和 batchPreValidate.validateFileForPush
 *      各自实现了一份完全相同的 headers/rows → RowLike[] 转换循环，
 *      1w 行 × 20 列 = 20w 次属性赋值在 CSV 场景下会被执行"两次"。
 *    · 且行数据在两个调用点都不能缓存（各自独立 parse），所以只能通过"抽公共函数
 *      + 单次遍历"来降低维护成本，避免任一处修复后另一处遗漏。
 *
 *  设计原则：
 *    · 纯函数：仅接收 headers/rows，返回 RowLike[]，无副作用；
 *    · 空值兜底：cells[i] 为 undefined/null 时写入空串 ''，与旧实现完全等价；
 *    · headers 为空数组时返回空对象数组（长度=rows.length），保证 runValidators
 *      仍能按行号定位，但所有中文列名 key 都缺失（相当于旧实现的自然行为）。
 * ============================================================================
 */
import type { RowLike } from '../handlers/pushCore.types';

/**
 * 将 CSV parser 输出的 headers + rows 组装为以中文列名为 key 的 RowLike 数组。
 *
 * @param headers   parser.tableData.headers（中文列名数组）
 * @param rows      parser.tableData.rows（每行 string[]，与 headers 同索引对齐）
 * @returns         每行一个对象，key = headers[i]，value = cells[i] ?? ''
 */
export function buildCsvRowLikes(
    headers: string[] | undefined,
    rows: string[][] | undefined,
): RowLike[] {
    const hs = Array.isArray(headers) ? headers : [];
    const rs = Array.isArray(rows) ? rows : [];
    const out: RowLike[] = new Array(rs.length);
    for (let r = 0; r < rs.length; r++) {
        const cells = rs[r] || [];
        const obj: RowLike = {};
        for (let i = 0; i < hs.length; i++) {
            (obj as any)[hs[i]] = cells[i] ?? '';
        }
        out[r] = obj;
    }
    return out;
}
