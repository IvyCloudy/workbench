---
name: yaml-format-fix
description: This skill should be used when the user asks to fix, validate, or clean up YAML files. It automatically detects and fixes: tab indentation, trailing spaces, missing space after colon, Boolean ambiguity, unquoted reserved characters, # in values, nested mapping errors, and missing closing quotes. Always run the bundled script — do NOT attempt to fix YAML manually with LLM reasoning.
---

# YAML Format Fix

## Purpose

Automatically detect and fix YAML formatting issues using a deterministic script. The LLM's sole responsibility is to execute the script and relay results — **never** attempt to reason about or manually edit YAML content.

## When to Trigger

Any mention of fixing, cleaning, validating, or formatting YAML files. Example triggers:
- "修复这个 yaml 文件"
- "检查这个 yaml 的格式问题"
- "这个 yaml 解析报错，帮我修一下"
- "格式化 yaml"

## How to Use

### Step 1: Run the script immediately

```bash
node scripts/fix-yaml.js <file-path>
```

For preview-only (no file modification):
```bash
node scripts/fix-yaml.js <file-path> --dry-run
```

For machine-readable output:
```bash
node scripts/fix-yaml.js <file-path> --json
```

### Step 2: Relay results

Report the output to the user verbatim. Do NOT summarize, re-interpret, or add opinions.

### Step 3: If user wants more detail

Only if the user asks "why" or "how", consult:

- `references/detection-rules.md` — Complete table of 10 detection rules
- `references/fix-strategies.md` — Fix generation algorithms and edge cases

## Script Behavior

The script (`scripts/fix-yaml.js`) is a self-contained Node.js program that:

1. Reads the YAML file
2. Runs the same 10-rule detection pipeline as the VS Code extension
3. Applies all auto-fixable issues in one pass (bottom-to-top, descending sort)
4. Writes the fixed file back (unless `--dry-run`)
5. Outputs a human-readable summary of all issues found and fixed

It requires the `yaml` npm package, which is already a project dependency.

## Important: Do NOT do manual YAML repair

Under no circumstances should the LLM attempt to:
- Generate fix suggestions based on LLM reasoning
- Manually edit YAML files to fix formatting
- Interpret or guess at YAML parse errors

All fix logic is already encoded in the script. The script is deterministic, comprehensive, and covers all edge cases (quote selection, special whitespace stripping, sequence-vs-keyValue matching priority) that the LLM would likely mishandle.
