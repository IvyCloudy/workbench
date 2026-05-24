// ============ 通用 UI 组件库（前端 Webview 使用） ============
//
// 设计原则：
// - 仅提供"纯 UI 组件"和"工具函数"
// - 不与 vscode API 直接耦合，由各页面 main.js 自行处理消息收发
// - 使用 ESM 标准导出，HTML 中以 <script type="module"> 加载

// 组件
export { Table } from './components/Table.js';
export { FileTree } from './components/FileTree.js';
export { Loading } from './components/Loading.js';
export { Tooltip } from './components/Tooltip.js';

// 工具函数
export { escapeHtml, escapeAttr, debounce } from './utils/helpers.js';