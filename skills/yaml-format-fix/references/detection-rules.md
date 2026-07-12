# Detection Rules Reference

> This document lists the **12 rules** actually enforced by both `scripts/fix-yaml.js` (Node) and `scripts/fix_yaml.py` (Python). Both scripts are 1:1 ports of the VS Code extension (`src/utils/yamlRules.ts` + `src/utils/yamlValidator.ts`).

## Rule 1 (BOM): BOM Header

- **ID**: `BOM`
- **Pattern**: File starts with `U+FEFF` (Byte Order Mark)
- **Severity**: warning
- **Fix**: Strip `U+FEFF` from the first line (`line.slice(1)` / `line[1:]`)
- **Message**: "文件开头包含 BOM (Byte Order Mark)，可能导致解析异常"

## Rule 2 (R1): Tab Indentation

- **ID**: `R1` (`stopOnHit`)
- **Pattern**: Line starts with one or more `\t` characters (`/^(\t+)/`)
- **Severity**: error (fatal — YAML spec strictly prohibits tab indentation)
- **Fix**: Replace each leading `\t` with **2 spaces** (`'  '.repeat(tabs.length)`), matching the "2-space parent map key" convention used by teammates
- **Critical**: When detected, **skip all other rules for this line** (`stopOnHit = true`) to avoid producing conflicting fixes

## Rule 3 (R2): Inline Tab

- **ID**: `R2`
- **Pattern**: `\t` at position `> 0` (not leading indentation) AND **not** inside a quoted string AND **not** in the trailing whitespace region
- **Severity**: warning
- **Fix**: Replace each qualifying `\t` with a single space (leaves tabs inside quotes untouched)
- **Note**: Trailing-region tabs are delegated to R3 to avoid double-reporting
- **Message**: "字符串内容中包含 Tab 字符，可能被解析为缩进导致格式错误"

## Rule 4 (R3): Trailing Spaces

- **ID**: `R3`
- **Pattern**: `line !== line.trimEnd() && line.length > 0`
- **Severity**: warning
- **Fix**: `line.trimEnd()` (Python: `rstrip()`)
- **Rationale**: Trailing spaces can cause indentation level misjudgments

## Rule 5 (R4): Missing Space After Colon

- **ID**: `R4`
- **Pattern**: `findYamlColon(line) > 0` where character after `:` is **not** ` `, `\r`, or `\t`
- **Exclusions**:
  - URL protocol (`://`) — handled by `findYamlColon` itself
  - Time / C++ namespace (`::`) — handled by `findYamlColon` itself
  - Empty value part
  - Values already quoted or starting with digit
  - **Delegate to R5** when the value is an ambiguous keyword (yes/null/…) so R5 produces a one-step `k: "yes"` fix
  - **Delegate to R7** when the value contains reserved chars
- **Severity**: warning
- **Fix**: Insert a space right after the colon
- **Example**: `name:张三` → `name: 张三`

## Rule 6 (R8): Missing Space After Dash

- **ID**: `R8`
- **Pattern**: `/^(\s*)-([^\s-])/` — dash immediately followed by non-whitespace non-dash (excludes `--`, `---` document separator)
- **Severity**: warning
- **Fix**: Insert a space right after the dash
- **Example**: `-value` → `- value`

## Rule 7 (R5): Boolean / null / Special-Numeric Ambiguity

- **ID**: `R5`
- **Pattern**: Key-value where the (unquoted) value matches: `true|false|TRUE|FALSE|True|False|yes|no|YES|NO|Yes|No|on|off|ON|OFF|On|Off|null|NULL|Null|~|.inf|.nan|.INF|.NAN|Infinity|-Infinity`
- **Severity**: warning
- **Fix**: Wrap the value in quotes. Prefer `"`; use `'` when the value already contains `"`; escape internal `"` as `\"` when both quotes appear
- **Delegation**: Yields to R6 when value contains ` #` comment syntax (R6 wraps the whole "value + comment" together)
- **Unicode quote stripping**: `stripQuotes()` recognizes Chinese/Unicode quote marks (`\u2018\u2019\u201C\u201D\u300C\u300D\u300E\u300F\uFF02`) to avoid double-wrapping already-quoted values

## Rule 8 (R6): `#` in Unquoted Value

- **ID**: `R6`
- **Pattern**: `#` appears after `:` in value area, **preceded by a space**, **not inside open quotes**, with **non-empty comment text** after `#`
- **Severity**: warning
- **Fix**: Wrap the **entire** value area (including the comment text) in quotes: `${key}: "${value including # comment}"`
- **Example**: `desc: 需求编号 #12345` → `desc: "需求编号 #12345"`

## Rule 9 (R7): Reserved Characters in Unquoted Value

- **ID**: `R7`
- **Pattern**: Unquoted key-value value contains any of `{ } [ ] , & * ! > |` (`RESERVED_CHARS_PATTERN = /[\[\]{},&*!>|]/`)
- **Descriptions**: See `RESERVED_CHAR_DESCRIPTIONS` map
- **Severity**: warning
- **Fix**: Wrap value in quotes
- **Delegation**: Yields to R6 when the value also contains ` #` comment syntax
- **Exemptions** (`YAML_INDICATOR_PATTERNS` / `isYamlIndicatorValue` / `is_yaml_indicator_value`) —
  when the value (trimmed) starts with a legal YAML **indicator** it is a first-class syntax
  element, not a "string containing a reserved char", and MUST NOT be quoted:
  1. **Block scalar header** — `|`, `>`, with optional chomping (`+` / `-`) and/or explicit
     indentation digit (e.g. `|-`, `>+`, `|2`, `|2-`), optionally followed by a comment.
  2. **Alias** — `*name` (name = `[A-Za-z_][A-Za-z0-9_\-]*`), optionally followed by a comment.
     Inline value after alias is NOT valid YAML and will not be exempted.
  3. **Anchor** — `&name`, optionally followed by whitespace + inline value
     (e.g. `&anchor scalar_value` is valid YAML).
  4. **Tag** — `!name` / `!!type` / `!<verbatim-uri>`, optionally followed by
     whitespace + inline value (e.g. `!!str 12345`, `!MyType foo`, `!<tag:example.com,2026:x> v`).
  5. **Flow sequence** — `[...]` **must be closed** (starts with `[`, ends with `]`),
     optionally followed by a comment. Empty `[]`, `[1,2,3]`, and nested `[[a],[b]]` are all exempt.
     Unclosed `[foo` still triggers R7.
  6. **Flow mapping** — `{...}` **must be closed** (starts with `{`, ends with `}`),
     optionally followed by a comment. Empty `{}`, `{x:1,y:2}`, and nested `{a:{b:1}}` are all exempt.
     Unclosed `{foo` still triggers R7.
- **Non-exempt (still R7)**: reserved chars in the **middle** of the value, unclosed flow
  collections, or values that only look partially like indicators
  (e.g. `foo | bar`, `value [middle]`, `[unclosed`, `{missing_close`, `pattern &anchor *ref`).

## Rule 10 (F1): Duplicate Key (File-Level)

- **ID**: `F1`
- **Algorithm**: Stack-based scope tracking
  - Each map scope maintains `key → firstLineNum`
  - Scope stack layered by indent column
  - Each sequence item (`- ` prefix) opens an **independent** map scope (`isSeqItem = true`) so sibling sequence entries can reuse the same key names without false positives
- **Severity**: warning
- **Fix**: Rewrite the duplicate line to `<indent># [duplicate key removed] <original>` (preserves content, avoids parse error)
- **Message**: `第 N 行：key "X" 与第 M 行重复，后者会覆盖前者`

## Rule 11 (P*): Parser-Level Errors (from yaml / PyYAML library)

- **ID**: `P*`
- **Method**:
  - Node: `YAML.parseAllDocuments(content)` then iterate `doc.errors`; fallback to `YAML.parse(content)` in catch block
  - Python: `yaml.safe_load_all(content)`; extract `problem_mark` / `context_mark` from `YAMLError`
- **Severity**: error
- **Fix generation**: Delegated to `generateFixForParseError()` — covers four sub-cases:
  - **P1 nested map** (`"nested map"` / `"compact map"` / `"not allowed"`): try sequence pattern first, then key:value pattern; wrap value in quotes
  - **P2 missing closing quote** (`"missing closing"` + `"quote"`): count parity of `'` and `"` separately, append the missing one
  - **P3 same column** (`"same column"` / `"must start at"` / `"mapping values are not allowed here"`): comment out the line as `# [indent mismatch] <original>`
  - **P4 duplicate key** (`"map keys must be unique"` / `"found duplicate key"`): comment out as `# [duplicate key removed] <original>`
- **Deduplication**: Won't report if the same line already has an `error` from R1 or F1

## Rule 12 (W*): Parser-Level Warnings

- **ID**: `W*`
- **Method**: `YAML.parseAllDocuments(content)` then iterate `doc.warnings` (Node only; PyYAML does not expose warnings uniformly)
- **Severity**: warning
- **Fix**: no automatic fix generation
- **Deduplication**: Won't report if the same line already has a warning with the same message text
- **Fix**: No automatic fix generation
