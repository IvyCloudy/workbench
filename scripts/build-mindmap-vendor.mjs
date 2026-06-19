// ============================================================================
// scripts/build-mindmap-vendor.mjs
// ----------------------------------------------------------------------------
// 把 markmap-view（含其依赖 d3 等）预打包成 webview 可直接 <script> 加载的
// 单文件 IIFE。挂载点：window.markmap
//
// 运行：node scripts/build-mindmap-vendor.mjs
//      或 npm run build:mindmap-vendor
//
// 产物：media/pages/mindmap/vendor/markmap.bundle.js
//
// 设计说明：
// - VS Code 插件运行在离线环境，必须把所有 JS 资源打入插件包，不能走 CDN
// - markmap-view 是 ESM 包，需要打包成 IIFE 才能在 webview 的 <script> 中使用
// - 使用 esbuild 是因为已有 devDependency，无需新增构建工具
// ============================================================================

import { build } from 'esbuild';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'media/pages/mindmap/vendor/markmap.bundle.js');

// 临时入口文件，相对当前项目根，能正常解析 node_modules
const tmpDir = tmpdir();
const entry = join(tmpDir, `mm-entry-${process.pid}.js`);
const entryCode = [
  "import { Markmap, deriveOptions, loadCSS, loadJS } from 'markmap-view';",
  "window.markmap = { Markmap, deriveOptions, loadCSS, loadJS };",
  '',
].join('\n');

mkdirSync(join(ROOT, 'media/pages/mindmap/vendor'), { recursive: true });
writeFileSync(entry, entryCode, 'utf-8');

try {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    target: 'es2019',
    minify: true,
    outfile: OUT,
    legalComments: 'none',
    absWorkingDir: ROOT,
    nodePaths: [join(ROOT, 'node_modules')],
    logLevel: 'info',
  });
  console.log('[build-mindmap-vendor] done →', OUT);
} finally {
  try { rmSync(entry); } catch (_) { /* ignore */ }
}
