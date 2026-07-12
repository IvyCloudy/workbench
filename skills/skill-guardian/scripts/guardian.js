#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * ============================================================================
 *  Copyright (c) 2026 myronliu / Tencent Cloud Big Data. All rights reserved.
 *  skill-guardian — Proprietary Internal-Use License (see ../LICENSE).
 * ============================================================================
 *  scripts/guardian.js
 *  一键为任意 skill 目录加固：License 头 + manifest + 水印 [+ 可选混淆]
 *
 *  用法：
 *    node guardian.js <target-skill-dir> [options]
 *
 *  Subcommands:
 *    guard   <dir>   （默认）执行加固
 *    verify  <dir>   离线校验 manifest；返回 0 通过 / 97 失败
 *    unguard <dir>   卸载 License 头 + 运行时守卫块（回滚）
 *
 *  Options:
 *    --author "..."     版权归属人（默认 myronliu）
 *    --org "..."        组织（默认 Tencent Cloud Big Data）
 *    --year N           年份（默认当前年）
 *    --license "..."    License 名称（默认 Proprietary Internal-Use License）
 *    --skill-name "..." skill 名（默认取目标目录名）
 *    --version X.Y.Z    版本号（默认 1.0.0）
 *    --jurisdiction "…" LICENSE 里的适用法域（默认 the People's Republic of China）
 *    --obfuscate        为 scripts/*.js 额外生成混淆后的 .min.js
 *    --obfuscate-python 为 scripts/*.py 用 pyarmor 生成加密产物到 scripts/dist_pyarmor/
 *    --pyarmor-args "…" 透传给 pyarmor gen（如：--restrict --expired 2027-01-01）
 *    --refresh          刷新已存在的 License 头 / 运行时守卫块（用于改作者/年份/版本后重跑）
 *    --verbose / -v     详细日志
 *    --quiet   / -q     只打印 warn/error
 *    --json             以 JSON 汇总输出（配合 CI）
 *    --dry-run          仅预览
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─────────────────────────── CLI 解析 ───────────────────────────
function parseArgs(argv) {
    const opts = { _: [] };
    // 这些长选项必须消费下一个 token 作为值，即便下一个 token 也以 '--' 开头
    // （典型场景：--pyarmor-args "--restrict --expired 2027-01-01"）
    const VALUE_REQUIRED = new Set(['pyarmor-args']);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--obfuscate') opts.obfuscate = true;
        else if (a === '--obfuscate-strict') { opts.obfuscate = true; opts.obfuscateStrict = true; }
        else if (a === '--obfuscate-python') opts.obfuscatePython = true;
        else if (a === '--refresh') opts.refresh = true;
        else if (a === '--verbose' || a === '-v') opts.verbose = true;
        else if (a === '--quiet' || a === '-q') opts.quiet = true;
        else if (a === '--json') opts.json = true;
        else if (a === '--help' || a === '-h') opts.help = true;
        else if (a.startsWith('--')) {
            const k = a.slice(2);
            const next = argv[i + 1];
            const mustHaveValue = VALUE_REQUIRED.has(k);
            // 通常规则：下一个 token 存在且不是另一个 flag 时才当作值
            // 白名单选项：不管下一个 token 是不是 flag 都强制吃掉
            if (next !== undefined && (mustHaveValue || !next.startsWith('--'))) {
                opts[k] = next; i++;
            } else {
                opts[k] = true; // 未提供值的长选项当作布尔开关
            }
        } else opts._.push(a);
    }
    return opts;
}

function printHelp() {
    console.log(`
skill-guardian — 一键为 skill 目录加固版权保护

Usage:
  node guardian.js [guard]   <target-skill-dir> [options]   # 加固（默认子命令）
  node guardian.js verify    <target-skill-dir> [options]   # 离线校验 manifest
  node guardian.js unguard   <target-skill-dir> [options]   # 卸载 License 头/守卫块

Options:
  --author "..."     版权归属人（默认 myronliu）
  --org "..."        组织（默认 Tencent Cloud Big Data）
  --year N           年份（默认当前年）
  --license "..."    License 名称（默认 Proprietary Internal-Use License）
  --skill-name "..." skill 名（默认取目标目录名）
  --version X.Y.Z    版本号（默认从 SKILL.md 提取，否则 1.0.0）
  --jurisdiction "…" LICENSE 适用法域（默认 the People's Republic of China）
  --obfuscate        为 scripts/*.js 额外生成混淆后的 .min.js（safe 档：兼容 Node/Jest）
  --obfuscate-strict 混淆采用 strict 档（controlFlowFlattening + selfDefending，可能在部分 Node 环境崩）
  --obfuscate-python 为 scripts/*.py 用 pyarmor 生成加密产物到 scripts/dist_pyarmor/（需要预装 pyarmor）
  --pyarmor-args "…" 透传给 pyarmor gen（示例："--enable-jit --restrict --expired 2027-01-01"）
  --refresh          刷新已存在的 License 头 / 运行时守卫块（改作者/年份/版本后重跑）
  -v, --verbose      打印详细日志（含 walk/glob 命中）
  -q, --quiet        只打印 warn/error
  --json             以 JSON 输出结果（供 CI 解析）
  --dry-run          仅预览，不写入
`);
}

// ─────────────────────────── 配置合并 ───────────────────────────
function loadConfig(targetDir, cliOpts) {
    const cfgPath = path.join(targetDir, '.guardianrc.json');
    let file = {};
    if (fs.existsSync(cfgPath)) {
        try { file = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); vlog(`[guardian] loaded .guardianrc.json`); }
        catch (e) { warn(`[guardian] .guardianrc.json parse failed: ${e.message}`); }
    }
    const skillMeta = extractSkillMeta(targetDir);
    const defaults = {
        author: 'myronliu',
        org: 'Tencent Cloud Big Data',
        year: new Date().getFullYear(),
        license: 'Proprietary Internal-Use License',
        jurisdiction: "the People's Republic of China",
        skillName: path.basename(path.resolve(targetDir)),
        version: skillMeta.version || '1.0.0',
        obfuscate: false,
        obfuscatePython: false,
        pyarmorArgs: '',
        protectedFiles: null, // 为 null 时自动扫描；支持精确路径/目录/glob
        excludes: null,       // 走 walk 时的额外排除（精确路径/目录/glob）
    };
    const rawYear = cliOpts.year || file.year || defaults.year;
    const yearNum = Number(rawYear);
    const year = Number.isFinite(yearNum) && yearNum > 1970 ? yearNum : defaults.year;
    if (!Number.isFinite(yearNum) && rawYear !== undefined) {
        warn(`[guardian] invalid year '${rawYear}', fallback to ${defaults.year}`);
    }
    // 合并 .guardianignore 到 excludes
    const ignoreFile = path.join(targetDir, '.guardianignore');
    let ignoreList = [];
    if (fs.existsSync(ignoreFile)) {
        ignoreList = fs.readFileSync(ignoreFile, 'utf8')
            .split(/\r?\n/).map(s => s.trim())
            .filter(s => s && !s.startsWith('#'));
    }
    const excludes = []
        .concat(Array.isArray(file.excludes) ? file.excludes : [])
        .concat(ignoreList);
    return {
        author: cliOpts.author || file.author || defaults.author,
        org: cliOpts.org || file.org || defaults.org,
        year,
        // license 优先级：CLI > .guardianrc > SKILL.md 前言 > 默认
        license: cliOpts.license || file.license || skillMeta.license || defaults.license,
        jurisdiction: cliOpts.jurisdiction || file.jurisdiction || defaults.jurisdiction,
        skillName: cliOpts['skill-name'] || file.skillName || defaults.skillName,
        version: cliOpts.version || file.version || defaults.version,
        obfuscate: cliOpts.obfuscate || file.obfuscate || defaults.obfuscate,
        obfuscateStrict: !!cliOpts.obfuscateStrict,
        obfuscatePython: cliOpts.obfuscatePython || file.obfuscatePython || defaults.obfuscatePython,
        pyarmorArgs: cliOpts['pyarmor-args'] || file.pyarmorArgs || defaults.pyarmorArgs,
        protectedFiles: file.protectedFiles || defaults.protectedFiles,
        excludes: excludes.length ? excludes : null,
        refresh: !!cliOpts.refresh,
        dryRun: !!cliOpts.dryRun,
        verbose: !!cliOpts.verbose,
        quiet: !!cliOpts.quiet,
        json: !!cliOpts.json,
    };
}

function extractVersion(dir) {
    return extractSkillMeta(dir).version;
}

/** 同时抽取 SKILL.md 前言里的 version 和 license */
function extractSkillMeta(dir) {
    const out = { version: null, license: null };
    const skillMd = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(skillMd)) return out;
    const text = fs.readFileSync(skillMd, 'utf8');
    const mv = text.match(/^version:\s*([\w.\-]+)/mi);
    if (mv) out.version = mv[1];
    const ml = text.match(/^license:\s*(.+?)\s*$/mi);
    if (ml) out.license = ml[1].trim();
    return out;
}

// ─────────────────────────── 日志 ───────────────────────────
// 日志级别：0 quiet（仅 warn/error）| 1 normal | 2 verbose
// JSON 模式下所有 stdout 日志静默，最后统一输出一个 JSON summary
const LOG = { level: 1, json: false, buffer: [] };
function _push(kind, msg) { LOG.buffer.push({ kind, msg }); }
function log(msg)  { if (LOG.json) { _push('log', msg); return; } if (LOG.level >= 1) console.log(msg); }
function vlog(msg) { if (LOG.json) { _push('vlog', msg); return; } if (LOG.level >= 2) console.log(msg); }
function warn(msg) { if (LOG.json) { _push('warn', msg); return; } console.warn(msg); }
function step(n, msg) { if (LOG.json) { _push('step', `[step-${n}] ${msg}`); return; } if (LOG.level >= 1) console.log(`\n[guardian][step-${n}] ${msg}`); }

// ─────────────────────────── 工具 ───────────────────────────
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function readTemplate(name) {
    return fs.readFileSync(path.join(__dirname, '..', 'templates', name), 'utf8');
}

function renderTemplate(tpl, cfg) {
    const licenseShort = cfg.license.replace(/\s*Internal-Use License\s*/i, '').replace(/^Proprietary\s*/i, 'Proprietary') || 'Proprietary';
    return tpl
        .replace(/\{\{YEAR\}\}/g, String(cfg.year))
        .replace(/\{\{AUTHOR\}\}/g, cfg.author)
        .replace(/\{\{ORG\}\}/g, cfg.org)
        .replace(/\{\{LICENSE\}\}/g, cfg.license)
        .replace(/\{\{LICENSE_SHORT\}\}/g, licenseShort)
        .replace(/\{\{SKILL_NAME\}\}/g, cfg.skillName)
        .replace(/\{\{VERSION\}\}/g, cfg.version)
        .replace(/\{\{JURISDICTION\}\}/g, cfg.jurisdiction || "the People's Republic of China");
}

// ─────────────────────────── 轻量 glob 匹配（零依赖） ───────────────────────────
// 支持：`*`（不跨 /）、`**`（跨 /）、`?`、`[abc]` 字符类；不支持 `!` 否定与 `{a,b}` 分组
function globToRegExp(pattern) {
    // 归一：反斜杠 → 正斜杠
    let p = pattern.replace(/\\/g, '/');
    let re = '';
    for (let i = 0; i < p.length; i++) {
        const c = p[i];
        if (c === '*') {
            if (p[i + 1] === '*') { re += '.*'; i++; if (p[i + 1] === '/') i++; }
            else re += '[^/]*';
        } else if (c === '?') re += '[^/]';
        else if (c === '[') { const j = p.indexOf(']', i); if (j > i) { re += p.slice(i, j + 1); i = j; } else re += '\\['; }
        else if ('/.^$+(){}|'.includes(c)) re += '\\' + c;
        else re += c;
    }
    return new RegExp('^' + re + '$');
}
/** 判断 rel（相对 skill 根，正斜杠）是否命中 patterns 里任意一项。
 *  一项可以是：精确路径 / 目录（以 '/' 结尾或就是目录本身）/ glob。 */
function matchAny(rel, patterns) {
    if (!patterns || !patterns.length) return false;
    for (const raw of patterns) {
        const p = String(raw || '').replace(/\\/g, '/');
        if (!p) continue;
        if (p === rel) return true;
        // 目录前缀
        if (p.endsWith('/') && (rel === p.slice(0, -1) || rel.startsWith(p))) return true;
        // glob
        if (/[*?[]/.test(p)) { try { if (globToRegExp(p).test(rel)) return true; } catch (_) { /* ignore */ } }
        // 目录（无末尾 /）
        if (rel.startsWith(p + '/')) return true;
    }
    return false;
}

/** 把 protectedFiles 里的"精确路径/目录/glob"三态展开为具体相对路径列表 */
function expandProtectedFiles(root, patterns) {
    if (!patterns || !patterns.length) return null;
    const allRel = walk(root, [], null).map(a => relFromRoot(root, a));
    const out = new Set();
    for (const raw of patterns) {
        const p = String(raw || '').replace(/\\/g, '/');
        if (!p) continue;
        // 情况 A：精确路径且真实存在（含二进制/无扩展）
        const absP = path.join(root, p);
        if (fs.existsSync(absP) && fs.statSync(absP).isFile()) { out.add(p); continue; }
        // 情况 B：目录（末尾 / 或真实存在的目录）—— 递归吸收目录下所有"文本类"文件
        const dirCandidate = p.endsWith('/') ? p.slice(0, -1) : p;
        const absDir = path.join(root, dirCandidate);
        if (fs.existsSync(absDir) && fs.statSync(absDir).isDirectory()) {
            for (const rel of allRel) if (rel.startsWith(dirCandidate + '/')) out.add(rel);
            continue;
        }
        // 情况 C：glob
        if (/[*?[]/.test(p)) {
            let re; try { re = globToRegExp(p); } catch (_) { continue; }
            for (const rel of allRel) if (re.test(rel)) out.add(rel);
            continue;
        }
        // 情况 D：写错了/不存在 —— 保留原样，交给 step4 报 warn
        out.add(p);
    }
    return Array.from(out);
}

const DEFAULT_HARD_EXCLUDES = ['node_modules', '.git', 'dist', 'dist_pyarmor', '__pycache__', '.venv', '.mypy_cache', '.pytest_cache', '.idea', '.vscode', 'coverage'];
/** 递归遍历目录：
 *  - 硬排除固定目录（node_modules 等）
 *  - 若提供 root+excludes，则调用者视角的相对路径命中 excludes 也跳过
 */
function walk(dir, out = [], root = null, excludes = null) {
    for (const name of fs.readdirSync(dir)) {
        if (DEFAULT_HARD_EXCLUDES.includes(name)) continue;
        const abs = path.join(dir, name);
        let st; try { st = fs.statSync(abs); } catch (_) { continue; }
        if (root && excludes) {
            const rel = relFromRoot(root, abs);
            if (matchAny(rel, excludes)) { vlog(`  · exclude: ${rel}${st.isDirectory() ? '/' : ''}`); continue; }
        }
        if (st.isDirectory()) walk(abs, out, root, excludes);
        else out.push(abs);
    }
    return out;
}

function relFromRoot(root, abs) {
    return path.relative(root, abs).split(path.sep).join('/');
}

const GUARDIAN_BEGIN_JS = '// ─────────── GUARDIAN BEGIN';
const GUARDIAN_END_JS = '// ─────────── GUARDIAN END ───────────';
const GUARDIAN_BEGIN_PY = '# ─────────── GUARDIAN BEGIN';
const GUARDIAN_END_PY = '# ─────────── GUARDIAN END ───────────';
const LICENSE_HEADER_MARK = 'Unauthorized copy / modification / redistribution is strictly prohibited.';

/**
 * 剥离旧的 License 头（JS 或 Python 风格）。识别规则：
 *   - JS：形如 `/** … Unauthorized copy … *\/` 的整块注释
 *   - PY：连续以 `# ` 开头且含 Unauthorized 字样的注释块
 * 只剥离紧贴文件开头（或 shebang 之后）的第一块。
 */
function stripOldLicenseHeader(src, isPy) {
    if (!src.includes(LICENSE_HEADER_MARK)) return { src, stripped: false };
    let head = '';
    let body = src;
    if (body.startsWith('#!')) {
        const nl = body.indexOf('\n');
        head = body.slice(0, nl + 1);
        body = body.slice(nl + 1);
    }
    if (isPy) {
        // encoding 声明（PEP 263）保留在 body 前面，剥离结束后由 findPyInsertPoint 正确处理其位置
        let encoding = '';
        const encM = body.match(/^# -\*- coding[:=][^\n]*\n/);
        if (encM) { encoding = encM[0]; body = body.slice(encM[0].length); }

        // 形态 A：docstring 内的 License 段（"""...""" 或 '''...'''）
        const dsM = body.match(/^(\s*)("""|''')([\s\S]*?)(\2)/);
        if (dsM && dsM[3].includes(LICENSE_HEADER_MARK)) {
            const [full, indent, q, inner] = dsM;
            // 在 inner 中定位由 ===== 围栏包住的 License 段（首个 fence 到下一个 fence）
            const innerLines = inner.split('\n');
            let fenceIdx = [];
            for (let i = 0; i < innerLines.length; i++) {
                if (/^\s*={5,}\s*$/.test(innerLines[i])) fenceIdx.push(i);
                if (fenceIdx.length === 2) break;
            }
            let markLine = -1;
            for (let i = 0; i < innerLines.length; i++) {
                if (innerLines[i].includes(LICENSE_HEADER_MARK)) { markLine = i; break; }
            }
            if (fenceIdx.length === 2 && markLine > fenceIdx[0] && markLine < fenceIdx[1]) {
                // 只删围栏段（含两条围栏 + 中间行 + 后随空行）
                let dropEnd = fenceIdx[1] + 1;
                while (dropEnd < innerLines.length && innerLines[dropEnd].trim() === '') dropEnd++;
                const newInner = innerLines.slice(0, fenceIdx[0]).concat(innerLines.slice(dropEnd)).join('\n');
                if (newInner.trim() === '') {
                    // docstring 只剩空——整个 docstring 一起干掉
                    let rest = body.slice(full.length);
                    if (rest.startsWith('\n')) rest = rest.slice(1);
                    return { src: head + encoding + rest, stripped: true };
                }
                const rebuilt = `${indent}${q}${newInner}${q}`;
                return { src: head + encoding + rebuilt + body.slice(full.length), stripped: true };
            }
            // 有 mark 但没有识别到围栏——保守起见把整个 docstring 视为 License 头剥掉
            let rest = body.slice(full.length);
            if (rest.startsWith('\n')) rest = rest.slice(1);
            return { src: head + encoding + rest, stripped: true };
        }

        // 形态 B：纯 `#` 注释头（模板注入的正规形态）
        const lines = body.split('\n');
        let end = 0;
        let hit = false;
        while (end < lines.length && (lines[end].startsWith('#') || lines[end].trim() === '')) {
            if (lines[end].includes(LICENSE_HEADER_MARK)) hit = true;
            end++;
            if (hit && (end >= lines.length || !lines[end].startsWith('#'))) break;
        }
        if (!hit) return { src, stripped: false };
        while (end < lines.length && lines[end].trim() === '') end++;
        body = encoding + lines.slice(end).join('\n');
    } else {
        // JS 注释块 /** ... */
        const start = body.indexOf('/**');
        if (start < 0) return { src, stripped: false };
        const stop = body.indexOf('*/', start);
        if (stop < 0) return { src, stripped: false };
        // 确保这块注释确实包含 mark
        if (!body.slice(start, stop).includes(LICENSE_HEADER_MARK)) return { src, stripped: false };
        let after = stop + 2;
        // 吃掉紧跟的换行
        if (body[after] === '\n') after++;
        body = body.slice(0, start) + body.slice(after);
    }
    return { src: head + body, stripped: true };
}

/** 剥离 GUARDIAN BEGIN … END 整段 */
function stripOldGuardBlock(src, isPy) {
    const begin = isPy ? GUARDIAN_BEGIN_PY : GUARDIAN_BEGIN_JS;
    const end = isPy ? GUARDIAN_END_PY : GUARDIAN_END_JS;
    const b = src.indexOf(begin);
    if (b < 0) return { src, stripped: false };
    const e = src.indexOf(end, b);
    if (e < 0) return { src, stripped: false };
    let after = e + end.length;
    if (src[after] === '\n') after++;
    // 顺带吞掉多余空行
    while (src[after] === '\n') after++;
    // 保留之前的一个换行
    let before = b;
    if (before > 0 && src[before - 1] === '\n') before--;
    return { src: src.slice(0, before) + '\n' + src.slice(after), stripped: true };
}

/**
 * 检测源文件是否已包含「未加 GUARDIAN 标记」的手写守卫代码
 * 目的：防止 --refresh 时把新守卫块叠加在旧手写块之前，导致重复声明 / 语法错误
 * 返回命中的指纹关键字（若无则返回 null）
 */
function detectHandWrittenGuard(src, isPy) {
    if (isPy) {
        const marks = [
            /def\s+verify_integrity\s*\(/,
            /def\s+print_watermark\s*\(/,
            /_hashlib\.sha256/,
        ];
        for (const re of marks) if (re.test(src)) return re.source;
    } else {
        const marks = [
            /function\s+verifyIntegrity\s*\(/,
            /function\s+printWatermark\s*\(/,
            /const\s+_crypto\s*=\s*require\(['"]crypto['"]\)/,
        ];
        for (const re of marks) if (re.test(src)) return re.source;
    }
    return null;
}

// ─────────────────────────── Step 1: LICENSE 文件 ───────────────────────────
function step1WriteLicense(root, cfg) {
    step(1, 'Writing LICENSE file');
    const tpl = readTemplate('LICENSE.template');
    const content = renderTemplate(tpl, cfg);
    const dest = path.join(root, 'LICENSE');
    if (cfg.dryRun) { log(`  [dry-run] would write ${dest}`); return; }
    fs.writeFileSync(dest, content, 'utf8');
    log(`  ✓ wrote ${dest}`);
}

// ─────────────────────────── Step 2: License 头注入 ───────────────────────────
function step2InjectHeaders(root, cfg) {
    step(2, 'Injecting License headers into source files');
    const jsHeaderTpl = readTemplate('license-header.js.txt');
    const pyHeaderTpl = readTemplate('license-header.py.txt');
    const jsHeader = renderTemplate(jsHeaderTpl, cfg);
    const pyHeader = renderTemplate(pyHeaderTpl, cfg);

    const files = walk(root, [], root, cfg.excludes).filter(f => /\.(js|ts|mjs|cjs|py)$/.test(f));
    let plannedCount = 0;
    for (const f of files) {
        const isPy = f.endsWith('.py');
        const header = isPy ? pyHeader : jsHeader;
        let src = fs.readFileSync(f, 'utf8');
        const rel = relFromRoot(root, f);
        if (src.includes(LICENSE_HEADER_MARK)) {
            if (!cfg.refresh) {
                log(`  · skip (already has license): ${rel}`);
                continue;
            }
            const r = stripOldLicenseHeader(src, isPy);
            if (r.stripped) {
                src = r.src;
                log(`  ↻ refresh: stripped old header: ${rel}`);
            } else {
                log(`  · skip (header mark found but couldn't strip): ${rel}`);
                continue;
            }
        } else if (/Copyright\s*\(c\)/i.test(src.slice(0, 600))) {
            // 兜底：文件顶部已有手写 Copyright 声明但缺 mark → 避免重复注入相似头
            warn(`  ! skip (hand-written Copyright detected, would duplicate): ${rel}`);
            warn(`    → 请手动删除文件顶部已有的 Copyright 注释块后再重跑，或改用 \`--refresh\` 前先 \`unguard\`。`);
            continue;
        }
        // 计算插入点：shebang 之后 + 若为 Python 再跳过 encoding 声明
        let prefixEnd = 0;
        if (src.startsWith('#!')) {
            const nl = src.indexOf('\n');
            prefixEnd = nl < 0 ? src.length : nl + 1;
        }
        if (isPy) {
            const rest = src.slice(prefixEnd);
            const encM = rest.match(/^# -\*- coding[:=][^\n]*\n/);
            if (encM) prefixEnd += encM[0].length;
        }
        const newSrc = src.slice(0, prefixEnd) + header + src.slice(prefixEnd);
        if (cfg.dryRun) { plannedCount++; log(`  [dry-run] would ${cfg.refresh ? 're-inject' : 'inject'} header: ${rel}`); continue; }
        fs.writeFileSync(f, newSrc, 'utf8');
        log(`  ✓ header ${cfg.refresh ? 're-injected' : 'injected'}: ${rel}`);
    }
    if (cfg.dryRun) log(`  [dry-run] step-2 summary: ${plannedCount} file(s) would be written`);
}

// ─────────────────────────── Step 3: 运行时守卫注入 ───────────────────────────
function step3InjectRuntimeGuard(root, cfg) {
    step(3, 'Injecting runtime integrity guard + watermark');
    const jsSnippet = renderTemplate(readTemplate('runtime-guard.snippet.js'), cfg);
    const pySnippet = renderTemplate(readTemplate('runtime-guard.snippet.py'), cfg);

    const scriptsDir = path.join(root, 'scripts');
    if (!fs.existsSync(scriptsDir)) {
        warn('  ! no scripts/ dir found — skip runtime guard injection');
        return;
    }
    const entries = fs.readdirSync(scriptsDir)
        .filter(n => /\.(js|mjs|cjs|py)$/.test(n))
        .filter(n => !n.startsWith('gen-manifest') && !n.startsWith('guardian'))
        .filter(n => !matchAny(relFromRoot(root, path.join(scriptsDir, n)), cfg.excludes))
        .map(n => path.join(scriptsDir, n));
    let plannedCount = 0;

    for (const f of entries) {
        let src = fs.readFileSync(f, 'utf8');
        const isPy = f.endsWith('.py');
        const beginMark = isPy ? GUARDIAN_BEGIN_PY : GUARDIAN_BEGIN_JS;
        const rel = relFromRoot(root, f);
        if (src.includes(beginMark)) {
            if (!cfg.refresh) {
                log(`  · skip (already has guard): ${rel}`);
                continue;
            }
            const r = stripOldGuardBlock(src, isPy);
            if (r.stripped) {
                src = r.src;
                log(`  ↻ refresh: stripped old guard block: ${rel}`);
            } else {
                log(`  · skip (guard mark found but couldn't strip): ${rel}`);
                continue;
            }
        } else {
            // 兜底：检测「未加 GUARDIAN 标记」的手写守卫代码，避免叠加
            const hit = detectHandWrittenGuard(src, isPy);
            if (hit) {
                warn(`  ! skip (hand-written guard detected, would collide): ${rel} — matched /${hit}/`);
                warn(`    → 请手动删除该文件里已有的完整性/水印代码后再重跑，或用 \`unguard\` 卸载。`);
                continue;
            }
        }
        const snippet = isPy ? pySnippet : jsSnippet;
        const insertAt = isPy ? findPyInsertPoint(src) : findJsInsertPoint(src);
        const before = src.slice(0, insertAt);
        const after = src.slice(insertAt);
        const newSrc = before + '\n\n' + snippet + '\n' + after;
        if (cfg.dryRun) { plannedCount++; log(`  [dry-run] would ${cfg.refresh ? 're-inject' : 'inject'} guard: ${rel}`); continue; }
        fs.writeFileSync(f, newSrc, 'utf8');
        log(`  ✓ guard ${cfg.refresh ? 're-injected' : 'injected'}: ${rel}`);
    }
    if (cfg.dryRun) log(`  [dry-run] step-3 summary: ${plannedCount} file(s) would be written`);
    log('  → 提示：入口函数需自行调用 verifyIntegrity(logger) / verify_integrity(logger) 和 printWatermark / print_watermark');
}

// ─────────────────────────── Step 4: manifest.json ───────────────────────────
function step4GenerateManifest(root, cfg) {
    step(4, 'Generating manifest.json (SHA256 integrity list)');
    const files = {};
    const scanList = cfg.protectedFiles
        ? expandProtectedFiles(root, cfg.protectedFiles)
        : autoProtectedFiles(root, cfg.excludes);
    for (const rel of scanList) {
        const abs = path.join(root, rel);
        if (!fs.existsSync(abs)) { warn(`  ! not found: ${rel}`); continue; }
        const buf = fs.readFileSync(abs);
        files[rel] = sha256(buf);
        vlog(`  · ${rel}  ${files[rel].slice(0, 12)}…`);
    }
    log(`  ✓ ${Object.keys(files).length} file(s) hashed`);
    const manifest = {
        name: cfg.skillName,
        version: cfg.version,
        author: `${cfg.author} / ${cfg.org}`,
        license: cfg.license,
        generatedAt: new Date().toISOString(),
        files,
    };
    const dest = path.join(root, 'manifest.json');
    if (cfg.dryRun) { log(`  [dry-run] would write ${dest}`); return; }
    fs.writeFileSync(dest, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    log(`  ✓ wrote ${dest}`);
}

function autoProtectedFiles(root, excludes) {
    const list = [];
    for (const abs of walk(root, [], root, excludes)) {
        const rel = relFromRoot(root, abs);
        if (rel === 'manifest.json' || rel === '.guardianrc.json' || rel === '.guardianignore') continue;
        if (/\.(md|js|ts|mjs|cjs|py|txt|json)$/.test(rel) || rel === 'LICENSE') list.push(rel);
    }
    return list;
}

// ─────────────────────────── verify 子命令 ───────────────────────────
function cmdVerify(root, cfg) {
    const manifestPath = path.join(root, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        warn(`[verify] manifest.json not found in ${root}`);
        return { ok: false, code: 97, reason: 'manifest_missing' };
    }
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch (e) { warn(`[verify] manifest.json parse failed: ${e.message}`); return { ok: false, code: 97, reason: 'manifest_parse_error' }; }
    const mismatches = [];
    for (const [rel, expected] of Object.entries(manifest.files || {})) {
        const abs = path.join(root, rel);
        let actual = null;
        try { actual = sha256(fs.readFileSync(abs)); } catch (_) { /* missing */ }
        if (actual !== expected) mismatches.push({ rel, expected, actual });
        else vlog(`  ✓ ${rel}`);
    }
    if (mismatches.length) {
        warn(`[verify] TAMPERED — ${mismatches.length} file(s) mismatch:`);
        for (const m of mismatches) warn(`  - ${m.rel}: expect ${String(m.expected).slice(0,12)}… got ${String(m.actual).slice(0,12)}…`);
        return { ok: false, code: 97, reason: 'tampered', mismatches, manifest };
    }
    log(`[verify] ✅ OK — ${Object.keys(manifest.files || {}).length} file(s) match manifest v${manifest.version || '?'}`);
    return { ok: true, code: 0, manifest };
}

// ─────────────────────────── unguard 子命令 ───────────────────────────
function cmdUnguard(root, cfg) {
    step(1, 'Removing runtime guard blocks + license headers');
    const files = walk(root, [], root, cfg.excludes).filter(f => /\.(js|ts|mjs|cjs|py)$/.test(f));
    let stripHeaderCnt = 0, stripGuardCnt = 0, wroteCnt = 0;
    for (const f of files) {
        const isPy = f.endsWith('.py');
        const rel = relFromRoot(root, f);
        let src = fs.readFileSync(f, 'utf8');
        let changed = false;
        // 先剥 guard 块（在头部之后），再剥 License 头（在头部）
        const g = stripOldGuardBlock(src, isPy);
        if (g.stripped) { src = g.src; changed = true; stripGuardCnt++; log(`  ↻ stripped guard block: ${rel}`); }
        const h = stripOldLicenseHeader(src, isPy);
        if (h.stripped) { src = h.src; changed = true; stripHeaderCnt++; log(`  ↻ stripped license header: ${rel}`); }
        if (changed) {
            if (cfg.dryRun) log(`  [dry-run] would rewrite: ${rel}`);
            else { fs.writeFileSync(f, src, 'utf8'); wroteCnt++; }
        }
    }
    log(`  ✓ done. headers=${stripHeaderCnt}, guards=${stripGuardCnt}, written=${cfg.dryRun ? '0 (dry-run)' : wroteCnt}`);
    // 顺带删除 LICENSE / manifest.json（可选：保留由用户手工决定）
    log('  → 未自动删除 LICENSE 与 manifest.json；如需完全回滚请手工 rm。');
    return { ok: true, code: 0, stripHeaderCnt, stripGuardCnt, wroteCnt };
}

// ─────────────────────────── 插入点定位（JS / PY 分开处理） ───────────────────────────
/**
 * 在 JS 源文件中找到 “GUARDIAN 块” 的插入位置。
 * 优先级：
 *   1. 若文件开头有 shebang（`#!`），跳过该行。
 *   2. 若存在 License 头（包含 LICENSE_HEADER_MARK 的块注释 /** ... *\/），插在该块之后。
 *   3. 跳过紧跟的 'use strict' / "use strict" 声明。
 *   4. 否则插入到当前位置（文件开头）。
 */
function findJsInsertPoint(src) {
    let pos = 0;
    if (src.startsWith('#!')) {
        const nl = src.indexOf('\n', pos);
        pos = nl < 0 ? src.length : nl + 1;
    }
    // 定位 License 头：必须是 “包含 mark 的 /** ... */ 块”
    const markIdx = src.indexOf(LICENSE_HEADER_MARK, pos);
    if (markIdx > 0) {
        const blockStart = src.lastIndexOf('/**', markIdx);
        const blockEnd = src.indexOf('*/', markIdx);
        if (blockStart >= pos && blockEnd > blockStart) {
            pos = blockEnd + 2;
            if (src[pos] === '\n') pos++;
        }
    }
    // 跳过 'use strict' / "use strict"
    const rest = src.slice(pos, pos + 40);
    const usm = rest.match(/^\s*(['"])use strict\1\s*;?/);
    if (usm) pos += usm[0].length;
    return pos;
}

/**
 * 在 Python 源文件中找到 “GUARDIAN 块” 的插入位置。
 * 优先级：
 *   1. 跳过 shebang。
 *   2. 跳过 encoding 注释（`# -*- coding: ... -*-`）。
 *   3. 若存在 License 头（连续 # 开头且含 LICENSE_HEADER_MARK），插在其后。
 *   4. 若之后紧跟模块 docstring（`"""..."""` 或 `'''...'''`），插在 docstring 之后（否则会破坏 PEP 257）。
 */
function findPyInsertPoint(src) {
    const lines = src.split('\n');
    let i = 0;
    if (lines[i] && lines[i].startsWith('#!')) i++;
    if (lines[i] && /coding[:=]/.test(lines[i]) && lines[i].startsWith('#')) i++;
    // 跳过 License 头注释块（连续 # 行，且块内含 mark）
    let hStart = i, hEnd = i, sawMark = false;
    while (hEnd < lines.length && (lines[hEnd].startsWith('#') || lines[hEnd].trim() === '')) {
        if (lines[hEnd].includes(LICENSE_HEADER_MARK)) sawMark = true;
        hEnd++;
        if (sawMark && hEnd < lines.length && !lines[hEnd].startsWith('#')) break;
    }
    if (sawMark) {
        i = hEnd;
        while (i < lines.length && lines[i].trim() === '') i++;
    }
    // 跳过模块 docstring
    if (i < lines.length) {
        const t = lines[i].trimStart();
        const q = t.startsWith('"""') ? '"""' : (t.startsWith("'''") ? "'''" : null);
        if (q) {
            // 同行闭合?
            const rest = t.slice(3);
            if (rest.includes(q)) {
                i++;
            } else {
                let j = i + 1;
                while (j < lines.length && !lines[j].includes(q)) j++;
                i = j < lines.length ? j + 1 : lines.length;
            }
        }
    }
    // 跳过 `from __future__ import ...`（PEP 236 要求该语句必须出现在文件所有非注释/非 docstring 代码之前）
    while (i < lines.length && lines[i].trim() === '') i++;
    while (i < lines.length && /^\s*from\s+__future__\s+import\b/.test(lines[i])) {
        i++;
        while (i < lines.length && lines[i].trim() === '') i++;
    }
    // 返回字符偏移量
    let offset = 0;
    for (let k = 0; k < i && k < lines.length; k++) offset += lines[k].length + 1; // +1 for '\n'
    return Math.min(offset, src.length);
}

// ─────────────────────────── Step 5: 混淆（可选） ───────────────────────────
function step5Obfuscate(root, cfg) {
    if (!cfg.obfuscate) { log('\n[guardian][step-5] Obfuscation: skipped (--obfuscate not set)'); return; }
    const strict = !!cfg.obfuscateStrict;
    step(5, `Obfuscating JavaScript files → *.min.js  (mode: ${strict ? 'strict' : 'safe'})`);
    let JO;
    try { JO = require('javascript-obfuscator'); }
    catch (_) {
        warn(`  ! 'javascript-obfuscator' not installed.
    请先安装：
        npm install --save-dev javascript-obfuscator
    然后重跑：node guardian.js <dir> --obfuscate`);
        return;
    }
    const scriptsDir = path.join(root, 'scripts');
    if (!fs.existsSync(scriptsDir)) { warn('  ! no scripts/ dir'); return; }
    const jsFiles = fs.readdirSync(scriptsDir)
        .filter(n => n.endsWith('.js') && !n.endsWith('.min.js'))
        .filter(n => !n.startsWith('gen-manifest') && !n.startsWith('guardian'));
    // safe 档：关闭 selfDefending / controlFlowFlattening / deadCodeInjection，避免 Node 侧崩溃
    // strict 档：全开（原激进配置）
    const obfuscateOptions = strict ? {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.6,
        deadCodeInjection: true,
        deadCodeInjectionThreshold: 0.3,
        identifierNamesGenerator: 'hexadecimal',
        stringArray: true,
        stringArrayEncoding: ['base64'],
        stringArrayThreshold: 0.75,
        selfDefending: true,
        target: 'node',
        renameGlobals: false,
    } : {
        compact: true,
        controlFlowFlattening: false,
        deadCodeInjection: false,
        identifierNamesGenerator: 'hexadecimal',
        stringArray: true,
        stringArrayEncoding: ['base64'],
        stringArrayThreshold: 0.75,
        selfDefending: false,
        target: 'node',
        renameGlobals: false,
    };
    for (const name of jsFiles) {
        const src = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
        const result = JO.obfuscate(src, obfuscateOptions);
        const dest = path.join(scriptsDir, name.replace(/\.js$/, '.min.js'));
        if (cfg.dryRun) { log(`  [dry-run] would obfuscate → ${dest}`); continue; }
        fs.writeFileSync(dest, result.getObfuscatedCode(), 'utf8');
        log(`  ✓ obfuscated → ${relFromRoot(root, dest)}`);
    }
    log('  → 提示：如需让 manifest 覆盖 .min.js，将它们加入 .guardianrc.json 的 protectedFiles 后再跑一次 guardian（不带 --obfuscate）');
}

// ─────────────────────────── Step 6: Python 混淆（pyarmor，可选） ───────────────────────────
/**
 * 用 pyarmor 8+ 的 `gen` 命令加密 scripts/*.py。设计考虑：
 *  - 全新独立开关 --obfuscate-python，不复用 --obfuscate 的语义；
 *  - pyarmor 是**外部 CLI**（Python 生态）而非 npm 包，因此走 spawnSync 探测；
 *  - 产物输出到 scripts/dist_pyarmor/，避免污染源码目录；
 *  - guardian/gen-manifest 自身脚本不会被加密（同 step5 的过滤策略）；
 *  - 用户可通过 --pyarmor-args 透传高级 flag（如 --restrict / --expired / --enable-jit）。
 */
function step6ObfuscatePython(root, cfg) {
    if (!cfg.obfuscatePython) { log('\n[guardian][step-6] Python obfuscation: skipped (--obfuscate-python not set)'); return; }
    step(6, 'Obfuscating Python files with pyarmor → scripts/dist_pyarmor/');
    const { spawnSync } = require('child_process');

    // ── 收集要加密的 py 源 ──
    const scriptsDir = path.join(root, 'scripts');
    if (!fs.existsSync(scriptsDir)) { warn('  ! no scripts/ dir'); return; }
    const pyFiles = fs.readdirSync(scriptsDir)
        .filter(n => n.endsWith('.py'))
        .filter(n => !n.startsWith('gen-manifest') && !n.startsWith('guardian'));
    if (pyFiles.length === 0) { log('  · no .py files to obfuscate'); return; }

    const outDir = path.join(scriptsDir, 'dist_pyarmor');
    if (cfg.dryRun) {
        // dry-run 语义只做预览，不强制要求本机已安装 pyarmor
        log(`  [dry-run] would run: pyarmor gen -O ${outDir}${cfg.pyarmorArgs ? ' ' + cfg.pyarmorArgs : ''} ${pyFiles.join(' ')}`);
        return;
    }

    // ── 探测 pyarmor ──
    let probe = spawnSync('pyarmor', ['-v'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
        warn(`  ! 'pyarmor' not found on PATH.
    pyarmor 是商业软件（有免费额度），受商业授权约束，请自行确认合规。
    安装：
        pip install pyarmor
    验证：
        pyarmor -v
    然后重跑：node guardian.js <dir> --obfuscate-python`);
        return;
    }
    const versionLine = (probe.stdout || probe.stderr || '').trim().split('\n')[0];
    log(`  · detected: ${versionLine}`);

    // 清空旧产物目录，避免残留干扰 manifest
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }

    // ── 组装 pyarmor gen 命令 ──
    // pyarmor 8+ 语法：pyarmor gen [options] SCRIPT ...
    // 我们在 scripts/ 目录下运行，让 pyarmor 自己解析 runtime pack。
    const args = ['gen', '-O', 'dist_pyarmor'];
    if (cfg.pyarmorArgs) {
        // 简单拆词（不处理 shell 引号，用户高级需求可用配置文件）
        for (const tok of cfg.pyarmorArgs.split(/\s+/).filter(Boolean)) args.push(tok);
    }
    for (const n of pyFiles) args.push(n);

    vlog(`  · exec: pyarmor ${args.join(' ')}  (cwd=${scriptsDir})`);
    const run = spawnSync('pyarmor', args, { cwd: scriptsDir, encoding: 'utf8' });
    if (run.error) { warn(`  ! pyarmor spawn error: ${run.error.message}`); return; }
    if (run.status !== 0) {
        warn(`  ! pyarmor exited with status ${run.status}`);
        if (run.stdout) warn('  stdout:\n' + run.stdout);
        if (run.stderr) warn('  stderr:\n' + run.stderr);
        return;
    }
    if (run.stdout && LOG.level >= 2) vlog(run.stdout);
    // 列出产物做汇报
    let produced = [];
    try {
        const walkOut = (d) => {
            for (const n of fs.readdirSync(d)) {
                const abs = path.join(d, n);
                const st = fs.statSync(abs);
                if (st.isDirectory()) walkOut(abs);
                else produced.push(relFromRoot(root, abs));
            }
        };
        walkOut(outDir);
    } catch (_) { /* ignore */ }
    for (const rel of produced) log(`  ✓ pyarmor → ${rel}`);
    log(`  → 产物在 ${relFromRoot(root, outDir)}/（含 pyarmor_runtime_*/）。运行入口改为该目录下的加密文件。`);
    log('  → 提示：如需让 manifest 覆盖加密产物，将 scripts/dist_pyarmor/**（或具体文件）加入 .guardianrc.json 的 protectedFiles，再跑一次 guardian（不带 --obfuscate-python）');
}

// ─────────────────────────── main ───────────────────────────
function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help || opts._.length === 0) { printHelp(); process.exit(opts.help ? 0 : 1); }
    // 子命令识别：第一个位置参数如果是 verify/unguard/guard 就吃掉
    let sub = 'guard';
    if (['guard', 'verify', 'unguard'].includes(opts._[0])) sub = opts._.shift();
    if (opts._.length === 0) {
        console.error(`[guardian] target dir required for '${sub}'`); printHelp(); process.exit(1);
    }
    const target = path.resolve(opts._[0]);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
        console.error(`[guardian] target dir not found: ${target}`); process.exit(2);
    }
    // 日志级别必须在 loadConfig 前先设好（避免 loadConfig 内部的 vlog / warn 逆向污染 JSON stdout）
    LOG.json = !!opts.json;
    LOG.level = opts.quiet ? 0 : (opts.verbose ? 2 : 1);
    const cfg = loadConfig(target, opts);
    // loadConfig 中可能调整过（实际上以 opts 为准），保证最终一致
    LOG.json = cfg.json;
    LOG.level = cfg.quiet ? 0 : (cfg.verbose ? 2 : 1);
    // 头部横幅（quiet/json 下省略）
    if (LOG.level >= 1 && !LOG.json) {
        console.log('╔════════════════════════════════════════════════════════════════════╗');
        console.log(`║  skill-guardian — ${sub.padEnd(48, ' ')}║`);
        console.log('╚════════════════════════════════════════════════════════════════════╝');
        console.log(`  target      : ${target}`);
        console.log(`  skillName   : ${cfg.skillName}`);
        console.log(`  version     : ${cfg.version}`);
        console.log(`  author      : ${cfg.author}`);
        console.log(`  org         : ${cfg.org}`);
        console.log(`  year        : ${cfg.year}`);
        console.log(`  license     : ${cfg.license}`);
        console.log(`  jurisdiction: ${cfg.jurisdiction}`);
        console.log(`  obfuscate   : ${cfg.obfuscate}${cfg.obfuscateStrict ? ' (strict)' : ''}`);
        console.log(`  obfuscatePy : ${cfg.obfuscatePython}${cfg.pyarmorArgs ? ` [args="${cfg.pyarmorArgs}"]` : ''}`);
        console.log(`  refresh     : ${cfg.refresh}`);
        console.log(`  dryRun      : ${cfg.dryRun}`);
        if (cfg.excludes) console.log(`  excludes    : ${cfg.excludes.join(', ')}`);
    }

    let result = { ok: true, code: 0, subcommand: sub };
    try {
        if (sub === 'verify')       result = Object.assign(result, cmdVerify(target, cfg));
        else if (sub === 'unguard') result = Object.assign(result, cmdUnguard(target, cfg));
        else {
            step1WriteLicense(target, cfg);
            step2InjectHeaders(target, cfg);
            step3InjectRuntimeGuard(target, cfg);
            step4GenerateManifest(target, cfg);
            step5Obfuscate(target, cfg);
            step6ObfuscatePython(target, cfg);
            if (LOG.level >= 1 && !LOG.json) {
                console.log('\n[guardian] ✅ done. Protection layers applied:');
                console.log('  ① License header       ✓');
                console.log('  ② LICENSE file         ✓');
                console.log('  ③ Runtime integrity    ✓ (call verifyIntegrity / verify_integrity at entry)');
                console.log('  ④ Watermark            ✓ (call printWatermark / print_watermark at entry)');
                console.log('  ⑤ manifest.json        ✓');
                console.log(`  ⑥ JS obfuscation       ${cfg.obfuscate ? '✓' : '(skipped)'}`);
                console.log(`  ⑦ Py obfuscation       ${cfg.obfuscatePython ? '✓ (pyarmor)' : '(skipped)'}`);
                if (cfg.dryRun) console.log('\n  ⚠ dry-run: no files were modified.');
            }
        }
    } catch (e) {
        result = { ok: false, code: 1, subcommand: sub, error: e && e.message ? e.message : String(e) };
    }
    if (LOG.json) {
        process.stdout.write(JSON.stringify({
            subcommand: sub, target, ok: result.ok, code: result.code,
            cfg: { skillName: cfg.skillName, version: cfg.version, author: cfg.author, license: cfg.license, dryRun: cfg.dryRun, refresh: cfg.refresh, obfuscate: cfg.obfuscate, obfuscatePython: cfg.obfuscatePython, pyarmorArgs: cfg.pyarmorArgs },
            result,
            logs: LOG.buffer,
        }, null, 2) + '\n');
    }
    process.exit(result.code || 0);
}

main();
