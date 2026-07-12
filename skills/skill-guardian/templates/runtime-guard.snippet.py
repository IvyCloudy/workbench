# ─────────── GUARDIAN BEGIN (do not edit — auto-inserted by skill-guardian) ───────────
import hashlib as _hashlib
import json as _json
import os as _os
import platform as _platform
import getpass as _getpass
from pathlib import Path as _Path


def _sha256_file(fp):
    try:
        return _hashlib.sha256(_Path(fp).read_bytes()).hexdigest()
    except Exception:
        return None


def verify_integrity(logger):
    skill_root = _Path(__file__).resolve().parent.parent
    manifest_path = skill_root / 'manifest.json'
    if not manifest_path.exists():
        msg = '[integrity] manifest.json not found'
        if _os.environ.get('SKILL_STRICT') == '1':
            print(msg + ' — refuse to run under SKILL_STRICT=1'); raise SystemExit(97)
        logger.info(msg + ' — skip (dev mode)')
        return {'ok': True, 'skipped': True}
    try:
        manifest = _json.loads(manifest_path.read_text(encoding='utf-8'))
    except Exception as e:
        msg = f'[integrity] manifest.json parse failed: {e}'
        if _os.environ.get('SKILL_STRICT') == '1':
            print(msg); raise SystemExit(97)
        logger.warning(msg)
        return {'ok': False}
    mismatches = []
    for rel, expected in (manifest.get('files') or {}).items():
        actual = _sha256_file(skill_root / rel)
        if actual != expected:
            mismatches.append((rel, expected, actual))
    if mismatches:
        summary = '\n'.join(f'  - {r}: expect {str(e)[:12]}… got {str(a)[:12]}…' for r, e, a in mismatches)
        msg = f'[integrity] SKILL FILES TAMPERED ({len(mismatches)} file(s) mismatch):\n{summary}'
        if _os.environ.get('SKILL_STRICT') == '1':
            print(msg); raise SystemExit(97)
        logger.warning(msg)
        return {'ok': False, 'manifest': manifest, 'mismatches': mismatches}
    logger.info(f"[integrity] OK — verified {len(manifest.get('files') or {})} file(s) against manifest v{manifest.get('version', '?')}")
    return {'ok': True, 'manifest': manifest}


def _machine_fingerprint():
    raw = f"{_platform.node()}|{_getpass.getuser()}|{_platform.system()}|{_platform.machine()}"
    return _hashlib.sha256(raw.encode('utf-8')).hexdigest()[:8]


def _run_fingerprint():
    import time as _time
    # 运行后缀：pid 的 base36 + 启动毫秒时间戳末 4 位 base36
    def _b36(n):
        digits = '0123456789abcdefghijklmnopqrstuvwxyz'
        if n == 0: return '0'
        s = ''
        while n > 0:
            n, r = divmod(n, 36); s = digits[r] + s
        return s
    return f"{_b36(_os.getpid())}{_b36(int(_time.time() * 1000))[-4:]}"


def print_watermark(logger, manifest):
    ver = (manifest or {}).get('version', 'dev')
    fp = _machine_fingerprint()
    rp = _run_fingerprint()
    logger.info(f"[{{SKILL_NAME}} v{ver}] © {{YEAR}} {{AUTHOR}} · {{LICENSE_SHORT}} · fp={fp}.{rp}")
# ─────────── GUARDIAN END ───────────
