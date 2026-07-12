---
name: yaml-format-fix
author: myronliu / Tencent Cloud Big Data
license: Proprietary — Internal Use Only (see LICENSE)
version: 1.0.0
description: >-
  This skill handles ALL YAML syntax/formatting issues via bundled deterministic
  scripts — ZERO LLM tokens consumed for the actual fixing. Trigger whenever the
  user asks to fix, validate, lint, or clean up YAML files. Covers 12 categories
  of issues: tab indentation, inline-tab, trailing spaces, missing space after
  colon, missing space after '-', Boolean/null ambiguity, unquoted reserved
  characters, '#' in values, nested-mapping errors, missing closing quotes,
  duplicate keys, indent mismatches. Two runnable scripts (fix-yaml.js for
  Node.js, fix_yaml.py for Python) share identical behavior. HARD RULE: always
  run one of the bundled scripts — do NOT read the YAML content into the model
  context and do NOT attempt manual fixes with LLM reasoning.
---

# YAML Format Fix

> **⚡ Zero-token contract**: this skill fixes YAML **without consuming any LLM tokens** on the file content itself. All detection & repair logic lives in the bundled scripts. The LLM only spends tokens on: (1) picking JS or PY, (2) invoking the CLI, (3) relaying the CLI's output. **Never load the YAML content into the conversation for analysis.**

## Purpose

Automatically detect and fix YAML formatting issues using deterministic scripts.
The LLM's sole responsibility is to **execute a script and relay results** —
**never** read, analyze, or manually edit YAML content in-context.

Doing so would:
- Waste tokens on content the scripts already handle deterministically
- Risk incorrect fixes (LLMs are unreliable for whitespace / quote-nesting edge cases)
- Violate the skill's core contract

Two script implementations are provided; **both enforce the exact same 12 rules**
and are semantically equivalent. Byte-for-byte output may differ on extremely
malformed inputs because `js-yaml` reports all errors in one pass while `PyYAML`
reports only the first error at a time — re-running the script 1–2 times fully
converges both versions to a clean state.

| Language | Script | Deps | Best for |
|---|---|---|---|
| Node.js | `scripts/fix-yaml.js` | Only `yaml` (optional; already in project) | Running inside this VS Code extension repo |
| Python 3.8+ | `scripts/fix_yaml.py` | Only stdlib; `PyYAML` optional | Environments without Node / CI pipelines with Python |

## Dependencies (Zero Hard Requirements)

Neither script has a hard dependency. There is intentionally **no `package.json` / `requirements.txt`** shipped inside `scripts/` — the parser library is **soft-optional** and both scripts detect its absence at runtime and degrade gracefully.

### Runtime tiers

| Tier | JS deps | PY deps | Enabled rules | Fix coverage of typical YAML issues |
|---|---|---|---|---|
| Full  | `yaml` installed | `PyYAML` installed | **R1~R8 + F1 + P1~P4 (12 rules)** | ~99% |
| Basic | none | none | R1~R8 + F1 (9 rules) | ~85% |

- The scripts print `YAML parser: available (P1~P4 enabled)` or `NOT AVAILABLE (line-rules only)` on the first line of `--verbose` output so you always know which tier you are in.
- Basic tier still handles all whitespace / colon / dash / ambiguity / reserved-chars / duplicate-key cases; only parser-level cascades (unclosed quote, nested compact mapping, indent-column mismatch) are skipped.

### One-shot install commands (to unlock Full tier)

```bash
# Node side — from the repo root (uses whatever package manager is present)
npm i yaml            # or: pnpm add yaml / yarn add yaml

# Python side — into the active interpreter
python3 -m pip install pyyaml
```

Both installs are idempotent and safe to re-run. The scripts will pick them up automatically on the next invocation; no config file changes required.

### Are JS and Py effect-equivalent?

- **Rules R1~R8 + F1**: fully equivalent — same detection, same fix output (both are pure-string algorithms with no parser involvement).
- **Rules P1~P4**: **problem categories match**, but the underlying parser (`yaml` vs `PyYAML`) may report slightly different **error wording** and occasionally a ±1 line offset. Re-running the script 1–2 times converges both to a clean state.
- **Bottom line**: for the user-visible outcome ("is the YAML file valid after the fix?") the two scripts are equivalent. Choose based on which runtime is already available in the environment.

## When to Trigger

Any mention of fixing, cleaning, validating, or formatting YAML files. Example triggers:

- "修复这个 yaml 文件"
- "检查这个 yaml 的格式问题"
- "这个 yaml 解析报错，帮我修一下"
- "格式化 yaml"
- "fix / lint / clean yaml"

## How to Use

### Option A · Node.js (recommended when inside this project)

```bash
node skills/yaml-format-fix/scripts/fix-yaml.js <file>            # fix & write back
node skills/yaml-format-fix/scripts/fix-yaml.js <file> --dry-run  # preview only
node skills/yaml-format-fix/scripts/fix-yaml.js <file> --json     # machine-readable
node skills/yaml-format-fix/scripts/fix-yaml.js <file> --verbose  # full per-rule log
```

### Option B · Python

```bash
python3 skills/yaml-format-fix/scripts/fix_yaml.py <file>            # fix & write back
python3 skills/yaml-format-fix/scripts/fix_yaml.py <file> --dry-run  # preview only
python3 skills/yaml-format-fix/scripts/fix_yaml.py <file> --json     # machine-readable
python3 skills/yaml-format-fix/scripts/fix_yaml.py <file> --verbose  # full per-rule log
```

### Combined flags

- `--dry-run` / `-n`: do not modify the file; still print detection & would-apply summary
- `--json`: emit a single JSON object suitable for downstream tooling
- `--verbose` / `-v`: print every rule hit with BEFORE/AFTER JSON-quoted line text
- Exit code: `0` clean · `2` errors remaining after fix · `1` fatal

### Choosing between JS and Py

- Prefer **JS** when running inside this repo (the `yaml` lib is typically already available).
- Use **Py** on servers / CI where only Python is present.
- See the **Dependencies** section above for how each tier maps to rule coverage.

## Step-by-step Playbook

1. **Detect**: run the script (any language).
2. **Relay verbatim**: the CLI prints a formatted table plus one line per issue. Do NOT summarize or paraphrase — the exact output is authoritative.
3. **Iterate if needed**: when the summary shows `修复后剩余问题 > 0` and those remaining issues include `P*` (parser-level), simply run the script **1–2 more times**. Each pass fixes what the previous parse-error blocked (the cascading nature of YAML syntax errors means one pass rarely resolves everything).
4. **On demand**: if the user asks *why* / *how* each rule fires, consult:
   - `references/detection-rules.md` — Complete table of 12 detection rules
   - `references/fix-strategies.md` — Fix generation algorithms and edge cases

## Rule Coverage (all 12, both languages)

| Rule | ID | Category | Severity | Auto-fix |
|---|---|---|---|---|
| BOM header | BOM | file-level | warning | strip U+FEFF |
| Tab indentation | R1 | line, `stopOnHit` | error | `\t` → 2 spaces |
| Inline tab | R2 | line | warning | tab → space (outside quotes) |
| Trailing spaces | R3 | line | warning | `rstrip` |
| Missing space after `:` | R4 | line | warning | insert 1 space |
| Missing space after `-` | R8 | line | warning | insert 1 space |
| Boolean/null ambiguity | R5 | line | warning | wrap in quotes |
| `#` in value | R6 | line | warning | wrap entire value in quotes |
| Reserved chars `{}[]&*!>|,` | R7 | line | warning | wrap in quotes |
| Duplicate key | F1 | file-level | warning | comment out later occurrence |
| Parser errors (nested map / missing quote / same-column / duplicate key) | P* | parser | error | context-aware fix |
| Parser warnings | W* | parser | warning | — |

## Logging Guarantee

`--verbose` prints one `[RULE ]` line per hit, followed by `BEFORE` / `AFTER` JSON-quoted line text.
The `[DEBUG] APPLY L<n>: <old> → <new>` lines confirm which lines actually got rewritten.

The default (non-verbose) output already prints the full issue table plus fix summary:
`(总问题数 / 可自动修复 / 应用修复行数 / 跳过行数 / 修复后剩余问题)`.

## Important: Do NOT do manual YAML repair

Under no circumstances should the LLM attempt to:
- Generate fix suggestions based on LLM reasoning
- Manually edit YAML files to fix formatting
- Interpret or guess at YAML parse errors

All fix logic is already encoded in the scripts. The scripts are deterministic, comprehensive, and cover all edge cases (quote selection, special whitespace stripping, sequence-vs-keyValue matching priority, sequence-scope duplicate-key isolation) that the LLM would likely mishandle.
