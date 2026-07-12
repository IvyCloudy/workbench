#!/usr/bin/env node
/**
 * ============================================================================
 *  Copyright (c) 2026 yyy / cc. All rights reserved.
 *  yaml-format-fix skill — Proprietary Internal-Use License (see ./LICENSE or ../LICENSE).
 *  Unauthorized copy / modification / redistribution is strictly prohibited.
 *  Integrity is verified at runtime against manifest.json.
 * ============================================================================
 */
/* eslint-disable no-console */
/**
 * ============================================================================
 *  scripts/gen-manifest.js
 *  发版前运行：扫描 skill 目录下的核心文件，计算 SHA256，写入 manifest.json。
 *  运行方式（在 skill 根目录）：
 *      node scripts/gen-manifest.js
 *  输出：
 *      manifest.json  —— { version, generatedAt, files: { <relPath>: <sha256> } }
 * ============================================================================
 *  Copyright (c) 2026 myronliu / Tencent Cloud Big Data. All rights reserved.
 *  Licensed under the Proprietary Internal-Use License (see ../LICENSE).
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKILL_ROOT = path.resolve(__dirname, '..');

/** 需要纳入完整性校验的文件（相对 skill 根目录） */
const PROTECTED_FILES = [
  'SKILL.md',
  'README.md',
  'LICENSE',
  'scripts/fix-yaml.js',
  'scripts/fix_yaml.py',
  'references/detection-rules.md',
  'references/fix-strategies.md',
];

function sha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function main() {
  const files = {};
  for (const rel of PROTECTED_FILES) {
    const abs = path.join(SKILL_ROOT, rel);
    if (!fs.existsSync(abs)) {
      console.warn(`[gen-manifest] SKIP (not found): ${rel}`);
      continue;
    }
    files[rel] = sha256(abs);
    console.log(`[gen-manifest] ${rel}  ${files[rel].slice(0, 12)}…`);
  }

  const manifest = {
    name: 'yaml-format-fix',
    version: '1.0.0',
    author: 'myronliu / Tencent Cloud Big Data',
    license: 'Proprietary — Internal Use Only',
    generatedAt: new Date().toISOString(),
    files,
  };

  const out = path.join(SKILL_ROOT, 'manifest.json');
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`\n[gen-manifest] wrote ${out}`);
}

main();
