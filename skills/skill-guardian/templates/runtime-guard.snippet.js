// ─────────── GUARDIAN BEGIN (do not edit — auto-inserted by skill-guardian) ───────────
// 完整性校验 + 水印 —— manifest.json 会在发版前用 gen-manifest.js 生成
const _crypto = require('crypto');
const _os = require('os');
function _sha256File(fp) {
    try { return _crypto.createHash('sha256').update(require('fs').readFileSync(fp)).digest('hex'); }
    catch (_) { return null; }
}
function verifyIntegrity(logger) {
    const path = require('path'); const fs = require('fs');
    const skillRoot = path.resolve(__dirname, '..');
    const manifestPath = path.join(skillRoot, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        const msg = '[integrity] manifest.json not found';
        if (process.env.SKILL_STRICT === '1') {
            console.error(msg + ' — refuse to run under SKILL_STRICT=1'); process.exit(97);
        }
        logger.info(msg + ' — skip (dev mode)');
        return { ok: true, skipped: true };
    }
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch (e) {
        const msg = `[integrity] manifest.json parse failed: ${e.message}`;
        if (process.env.SKILL_STRICT === '1') { console.error(msg); process.exit(97); }
        logger.warn(msg); return { ok: false };
    }
    const mismatches = [];
    for (const [rel, expected] of Object.entries(manifest.files || {})) {
        const actual = _sha256File(path.join(skillRoot, rel));
        if (actual !== expected) mismatches.push({ rel, expected, actual });
    }
    if (mismatches.length) {
        const summary = mismatches.map(m => `  - ${m.rel}: expect ${String(m.expected).slice(0,12)}… got ${String(m.actual).slice(0,12)}…`).join('\n');
        const msg = `[integrity] SKILL FILES TAMPERED (${mismatches.length} file(s) mismatch):\n${summary}`;
        if (process.env.SKILL_STRICT === '1') { console.error(msg); process.exit(97); }
        logger.warn(msg);
        return { ok: false, manifest, mismatches };
    }
    logger.info(`[integrity] OK — verified ${Object.keys(manifest.files).length} file(s) against manifest v${manifest.version || '?'}`);
    return { ok: true, manifest };
}
function _machineFingerprint() {
    const raw = [_os.hostname(), _os.userInfo().username || '', _os.platform(), _os.arch()].join('|');
    return _crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8);
}
function _runFingerprint() {
    // 与机器指纹拼接后的运行时后缀：pid + 启动毫秒时间戳的 base36 短串
    return `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
}
function printWatermark(logger, manifest) {
    const ver = (manifest && manifest.version) || 'dev';
    const fp = _machineFingerprint();
    const rp = _runFingerprint();
    logger.info(`[{{SKILL_NAME}} v${ver}] © {{YEAR}} {{AUTHOR}} · {{LICENSE_SHORT}} · fp=${fp}.${rp}`);
}
// ─────────── GUARDIAN END ───────────
