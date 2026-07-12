/**
 * ============================================================================
 *  parsers/yaml-parse-check.ts
 *  YAML 语法级可解析性检查（用于测试案例编辑器打开时的兜底拦截）
 * ----------------------------------------------------------------------------
 *  职责：调用 `yaml` 库尝试解析文本，明确回答两个问题：
 *    1) YAML.parseAllDocuments 是否成功且无 errors？
 *    2) 若失败，首个错误在哪一行、错误摘要是什么？
 *
 *  独立成文件的原因：
 *    - 不依赖 vscode API，可在 vitest 纯 Node 环境下直接引入并做单测。
 *    - 与"结构启发式判定"分离，规则清晰稳定（parse 抛错 = 不可解析）。
 *
 *  设计原则：
 *    - 只做语法级判定，不做任何"结构合规性猜测"。
 *    - 若 yaml 库能返回合法 Document 且 errors 为空，即视为可打开。
 *    - 用于拦截"打开案例编辑器后数据丢失"的场景——其真实根因是 parser 抛错，
 *      前端拿到 null 数据只能显示空表。
 * ============================================================================
 */
import * as YAML from 'yaml';

export interface YamlParseCheckResult {
    /** 是否可被 YAML 库合法解析 */
    ok: boolean;
    /** 首个错误的行号（1-based，未知时为 undefined） */
    errorLine?: number;
    /** 首个错误的原始 message（供错误页展示） */
    errorMessage?: string;
}

/**
 * 判定 YAML 文本是否可被 yaml 库解析。
 * 依次尝试 `parseAllDocuments`（多文档友好）→ `parse`（兜底），只要任一步能给出合法结果即视为可解析。
 * 只要 parseAllDocuments 返回的文档中有 error，或整体抛异常，就视为不可解析。
 */
export function checkYamlParseable(content: string): YamlParseCheckResult {
    // 空内容 / 全空白：视为可解析（parser 会返回空数组，业务上属于"新建/空文件"，允许打开）
    if (!content || content.trim() === '') {
        return { ok: true };
    }

    try {
        const docs = YAML.parseAllDocuments(content);
        // 收集所有文档的 errors；只要任一 doc 有 errors 就判定失败
        for (const doc of docs) {
            const errors: any[] = (doc as any).errors || [];
            if (errors.length > 0) {
                const first = errors[0];
                return {
                    ok: false,
                    errorLine: first?.linePos?.[0]?.line,
                    errorMessage: typeof first?.message === 'string' ? first.message : String(first),
                };
            }
        }
        return { ok: true };
    } catch (err: any) {
        // parseAllDocuments 抛错场景较少，但存在极端结构崩坏时会命中；再用 parse 兜一次尝试拿到行号
        try {
            YAML.parse(content);
            // 到这说明 parse 成功但 parseAllDocuments 抛了 —— 罕见但视为可解析（走原逻辑最稳）
            return { ok: true };
        } catch (parseErr: any) {
            return {
                ok: false,
                errorLine: parseErr?.linePos?.[0]?.line,
                errorMessage: typeof parseErr?.message === 'string' ? parseErr.message : String(parseErr),
            };
        }
    }
}
