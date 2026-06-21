// ============================================================================
// scripts/build-mindmap-vendor.mjs
// ----------------------------------------------------------------------------
// 用 esbuild 把 simple-mind-map ESM 源码打成 IIFE bundle，挂载到
// window.simpleMindMap，供 webview 离线 <script> 加载。
//
// 关键背景：
// 1. simple-mind-map 自带的 dist/simpleMindMap.umd.min.js 是用 webpack 打的，
//    内部存在 `new Function` / eval 调用（webpack runtime 的 cli-service 入口）。
//    VS Code webview 默认 CSP 不允许 'unsafe-eval'，会直接抛
//    "Evaluating a string as JavaScript violates ... Content Security Policy"。
// 2. 用 esbuild 从源码（ESM）重新打成 IIFE，就不会引入 webpack runtime，
//    完全不含 eval / new Function，可在严格 CSP 下加载。
// 3. 按需挂载常用插件（KeyboardNavigation/Drag/Select/Export/ExportXMind 等），
//    并启用 RichText（依赖 quill），从而激活引擎内置的"横向拖动改节点宽度"
//    手柄（enableDragModifyNodeWidth 必须配合 RichText 才会生效）。
//    避开依赖 katex 的 Formula、依赖 yjs/pdf-lib 的重型插件，控制 bundle 体积。
//
// 运行：node scripts/build-mindmap-vendor.mjs
//      或 npm run build:mindmap-vendor
//
// 产物：
//   media/pages/mindmap/vendor/simple-mind-map.bundle.js  （主 IIFE）
//   media/pages/mindmap/vendor/simple-mind-map.bundle.css （quill.snow 等样式）
// ============================================================================

import { build } from 'esbuild';
import { mkdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'media/pages/mindmap/vendor');
const OUT = join(OUT_DIR, 'simple-mind-map.bundle.js');
const ENTRY = join(OUT_DIR, '__smm-entry.js');

mkdirSync(OUT_DIR, { recursive: true });

// ---- 生成临时入口：仅引入"轻量&安全"的插件，挂到 window.simpleMindMap ----
const entrySrc = `
import MindMap from 'simple-mind-map';
import KeyboardNavigation from 'simple-mind-map/src/plugins/KeyboardNavigation.js';
import Drag from 'simple-mind-map/src/plugins/Drag.js';
import Select from 'simple-mind-map/src/plugins/Select.js';
import Export from 'simple-mind-map/src/plugins/Export.js';
import ExportXMind from 'simple-mind-map/src/plugins/ExportXMind.js';
import AssociativeLine from 'simple-mind-map/src/plugins/AssociativeLine.js';
import TouchEvent from 'simple-mind-map/src/plugins/TouchEvent.js';
import NodeImgAdjust from 'simple-mind-map/src/plugins/NodeImgAdjust.js';
import OuterFrame from 'simple-mind-map/src/plugins/OuterFrame.js';
import RichText from 'simple-mind-map/src/plugins/RichText.js';
import xmind from 'simple-mind-map/src/parse/xmind.js';
import markdown from 'simple-mind-map/src/parse/markdown.js';
import JSZip from 'jszip';

MindMap.usePlugin(Drag)
  .usePlugin(KeyboardNavigation)
  .usePlugin(Select)
  .usePlugin(Export)
  .usePlugin(ExportXMind)
  .usePlugin(AssociativeLine)
  .usePlugin(TouchEvent)
  .usePlugin(NodeImgAdjust)
  .usePlugin(OuterFrame)
  .usePlugin(RichText);

MindMap.xmind = xmind;
MindMap.markdown = markdown;

// 全局挂载：webview 中通过 window.simpleMindMap 使用
window.simpleMindMap = MindMap;
window.simpleMindMap.default = MindMap;
// 同时把 JSZip 暴露到 window，webview 端可以读 simple-mind-map 自带导出的
// .xmind 包，对 content.json 做后处理（注入 style/markers/attachment）。
window.JSZip = JSZip;
`;
writeFileSync(ENTRY, entrySrc, 'utf-8');

try {
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'iife',
    target: 'es2019',
    minify: true,
    // 改用 outdir + 命名入口：
    //   __smm-entry.js → simple-mind-map.bundle.js
    //   导入的 quill.snow.css 等 → simple-mind-map.bundle.css
    outdir: OUT_DIR,
    entryNames: 'simple-mind-map.bundle',
    assetNames: 'simple-mind-map.bundle-[name]',
    loader: {
      '.css': 'css',
      '.svg': 'dataurl',
      '.woff': 'dataurl',
      '.woff2': 'dataurl',
      '.ttf': 'dataurl',
      '.eot': 'dataurl',
    },
    legalComments: 'none',
    absWorkingDir: ROOT,
    nodePaths: [join(ROOT, 'node_modules')],
    logLevel: 'warning',
    // 严格保证产物不引入 eval（esbuild 默认即不会），但这里显式声明便于审计
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  });

  // ---- CSP 安全后处理 ----
  // jszip 内嵌的 setImmediate polyfill 含一行：
  //   if (typeof T !== "function") T = new Function(""+T);
  // 这是兜底分支（实际运行时不会触发，因为 simple-mind-map 总是传函数），
  // 但 VS Code webview 在脚本解析期 V8 就会因 `new Function` 直接拒绝执行。
  // 这里把这种"接受字符串当代码"的形态改写为安全的 noop 函数，让产物
  // 完全不含 `new Function(...)` 字面量。
  {
    const fs = await import('node:fs');
    let code = fs.readFileSync(OUT, 'utf-8');
    // 匹配模式：T=new Function(""+T)  /  =new Function(""+任意标识符)
    const before = code;
    code = code.replace(
      /=new Function\(""\+[A-Za-z_$][\w$]*\)/g,
      '=function(){}',
    );
    if (code !== before) {
      fs.writeFileSync(OUT, code, 'utf-8');
      console.log('[build-mindmap-vendor] sanitized: stripped `new Function`');
    }
  }

  const sz = statSync(OUT).size;
  console.log(
    '[build-mindmap-vendor] built →',
    OUT,
    `(${(sz / 1024).toFixed(1)} KB)`,
  );
} catch (err) {
  console.error('[build-mindmap-vendor] failed:', err);
  process.exit(1);
} finally {
  try { unlinkSync(ENTRY); } catch (_) {}
}
