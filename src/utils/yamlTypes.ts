/**
 * ============================================================================
 *  utils/yamlTypes.ts
 *  YAML 校验模块共用的类型定义（提取以避免循环依赖）
 * ============================================================================
 */

export interface YamlIssue {
    /** 1-based 行号 */
    line: number;
    /** 1-based 列号（问题起点） */
    column: number;
    /** 问题字符范围长度（用于生成精准的 Diagnostic.range） */
    length?: number;
    /** 简短标题（用于 Quick Fix 菜单显示，例如 "Tab 缩进"、"缺少空格"） */
    title?: string;
    /** 问题详细描述（已包含行号） */
    message: string;
    /** error = 可能导致解析失败，warning = 潜在格式问题 */
    severity: 'error' | 'warning';
    /** 建议修复后的整行内容（可选）；同一行支持多条 fix 串行叠加 */
    fix?: string;
}
