/**
 * ============================================================================
 *  yamlResolveFallback.ts
 *  CustomEditor 内的 YAML 语法兜底拦截
 * ----------------------------------------------------------------------------
 *  设计取舍（2026-11 调整 —— 尽最大可能用案例编辑器打开）：
 *    早期版本会在 resolveCustomEditor 阶段检测 YAML 语法错误、自动切换到文本编辑器，
 *    以避免案例编辑器渲染「空表 / 数据丢失」错误页。但实践中，复杂 YAML 在「首开瞬间」
 *    常因内存文档未就绪 / 外部写入竞态读到不完整内容，被误判为格式错误而误杀——而这些
 *    文件本可被案例编辑器正常打开。
 *
 *    现改为「解析口径尽量宽松，尽可能用案例编辑器打开」：本函数不再拦截 / 切换文本编辑器，
 *    永远 return false，把文件交给案例编辑器自行处理。语法瑕疵由案例编辑器自身的错误页 /
 *    Problems 面板承载（错误页已提供「用文本编辑器打开」按钮，真正损坏的文件仍可手动切换，
 *    不会出现数据丢失或崩溃）。
 *
 *  —— 如需重新启用拦截，请在此恢复判定逻辑，并确保使用 YamlFileParser.tryParseContent
 *     这种与案例编辑器完全一致的解析口径（见 yamlPreOpenInterceptor.ts 说明）。
 * ============================================================================
 */
import * as vscode from 'vscode';

/**
 * 在 resolveCustomEditor 内做 YAML 语法兜底拦截。
 *
 * @returns 当前实现恒为 false —— 不拦截，放行给案例编辑器自行处理。
 *          （历史实现会在命中不可解析时返回 true 并切换到文本编辑器，因误杀过多已停用。）
 */
export async function tryYamlResolveFallback(params: {
    document: vscode.CustomDocument;
    webviewPanel: vscode.WebviewPanel;
    filePath: string;
    fileName: string;
    log: (...args: any[]) => void;
    /** 由 BaseEditorProvider 静态提供，用于在静默切换前把 panelMap 中的本 panel 移除 */
    removePanelMapEntry: () => void;
}): Promise<boolean> {
    // 解析口径已调整为「尽最大可能用案例编辑器打开」：不再因 YAML 语法问题自动切换
    // 文本编辑器。直接放行给案例编辑器，由其自身错误页 / Problems 面板处理瑕疵。
    return false;
}
