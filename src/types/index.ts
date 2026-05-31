/**
 * ============================================================================
 *  types/index.ts
 *  全项目共享类型定义
 * ----------------------------------------------------------------------------
 *  包含：
 *    - TableData / DetailTableData       表格与明细表结构
 *    - SheetData / SheetRow / SheetCell  YAML 中间转换用的「伪表格」结构
 *    - QueryParams / QueryOptions        查询测试案例请求参数
 *    - AppConfig                         本地持久化配置
 *    - WebviewMessage                    前后端消息包通用结构
 *    - FileNode                          资源树节点
 *    - ApiResponse                       后端返回包
 *  原则：本文件仅定义类型，不包含运行时代码。
 * ============================================================================
 */

// ============================================
// 表格数据类型
// ============================================

export interface TableData {
    headers: string[];
    /**
     * 二维单元格值。绝大多数单元格为字符串；当 columnTypes[字段] === 'string[]' / 'number[]'
     * 时，该列每行的单元格值可能直接是 JS 数组（保留原始数组形态以支持"标签芯片+多项编辑"），
     * 这种数组只会在被识别为标量数组列的位置出现。
     */
    rows: any[][];
    detailTable?: DetailTableData;
    /**
     * 多明细字段：每一个顶层嵌套对象/对象数组字段对应一项。
     * 仅支持一层展开：子表单元格内若仍为嵌套结构，会被序列化为 JSON 字符串展示与编辑。
     * 兼容字段：detailTable 仍保留，等同于 detailTables[0]（若存在）。
     */
    detailTables?: DetailTableData[];
    /**
     * 列类型（按表头字段名）。仅由解析器在 parse 时输出，webview 用于决定渲染/编辑形态：
     *   - 'scalar'   ：普通文本列（默认，单行编辑）
     *   - 'string[]' ：字符串数组（chip 展示 + 多项编辑弹窗），仅当全列每行都是该类型时识别
     *   - 'number[]' ：数字数组（同上）
     *   - 'detail'   ：嵌套对象 / 对象数组列，由 detailTables 接管
     * 未识别 / 混合 / 脏数据 → 默认 'scalar'（保守降级）
     */
    columnTypes?: { [field: string]: 'scalar' | 'string[]' | 'number[]' | 'detail' };
}

export interface DetailTableData {
    field: string;
    fieldDisplay: string;
    headers: string[];
    /**
     * 每个主行对应的明细二维数据：
     * - 对象数组：多子行
     * - 嵌套对象：一行子表（headers 为 key 的并集，rowGroups[ri] 长度为 1）
     * - 无明细：空数组
     */
    rowGroups: string[][][];
    rawRowGroups?: any[][][];
    /**
     * 每个主行的原始 detail 类型，长度与主行数一致。
     * - 'array'：原始为对象数组
     * - 'object'：原始为嵌套对象
     * - 'none'：无明细
     */
    rawRowTypes?: ('array' | 'object' | 'none')[];
}

// ============================================
// CSV 数据类型
// ============================================

export interface SheetCell {
    text: string;
    style?: number;
}

export interface SheetRow {
    cells: { [key: number]: SheetCell };
}

export interface SheetData {
    name: string;
    rows: { [key: number]: SheetRow };
}

// ============================================
// 查询参数类型
// ============================================

export interface QueryParams {
    testTaskNo: string;
    subTestTaskName: string;
    testPhaseName: string;
}

export interface QueryOptions extends QueryParams {
    currentPage: number;
    pageSize: number;
    testCaseNo?: string;
    testCaseName?: string;
    testCasePath?: string;
    testCasePriority?: string;
    testType?: string;
    type?: string;
}

// ============================================
// 存储配置类型
// ============================================

export interface AppConfig {
    apiUrl: string;
    authToken: string;
    userId: string;
    userName: string;
    sm2PublicKey: string;
    /** 埋点网关地址，留空则回退到 apiUrl */
    telemetryUrl?: string;
    /** 埋点网关鉴权 Token，对应网关 X-Telemetry-Token */
    telemetryToken?: string;
}

// ============================================
// Webview 相关类型
// ============================================

export interface WebviewMessage {
    command?: string;
    type?: string;
    data?: any;
    [key: string]: any;
}

// ============================================
// 文件树类型
// ============================================

export interface FileNode {
    name: string;
    path: string;
    isDirectory: boolean;
    children?: FileNode[];
}

// ============================================
// API 返回类型
// ============================================

export interface ApiResponse<T = any> {
    returnCode: string;
    body?: T;
    errorMsg?: string;
    raw?: string;
}