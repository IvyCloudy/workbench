# Detection Rules Reference

## Rule 1: BOM Header

- **Pattern**: File starts with `U+FEFF` (Byte Order Mark)
- **Line 1, severity: warning**
- **Fix**: Manual removal (no automatic fix)
- **Message**: "文件开头包含 BOM (Byte Order Mark)，可能导致解析异常"

## Rule 2: Tab Indentation

- **Pattern**: Line starts with one or more `\t` characters
- **Severity: error** (fatal — YAML spec strictly prohibits tab indentation)
- **Fix**: Replace each tab with 4 spaces: `line.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length))`
- **Critical**: When detected, `continue` to skip all other checks for this line (to avoid generating multiple fixes for the same line)

## Rule 3: Tab in Content

- **Pattern**: `\t` at position > 0 (not leading indentation)
- **Severity: warning**
- **Fix**: No automatic fix
- **Message**: "字符串内容中包含 Tab 字符，可能被解析为缩进导致格式错误"

## Rule 4: Trailing Spaces

- **Pattern**: `line !== line.trimEnd() && line.length > 0`
- **Severity: warning**
- **Fix**: `line.trimEnd()`
- **Rationale**: Trailing spaces can cause indentation level misjudgments

## Rule 5: Missing Space After Colon

- **Pattern**: `line.indexOf(':') > 0` where character after `:` is **not** a space or `\r`
- **Exclusions**:
  - URL protocol (`://`) — e.g., `url:https://...`
  - Time/block indicators (`::`) — e.g., `time:12:00`
  - Values starting with digits (e.g., `port:8080`)
  - Already quoted values (`"value"` or `'value'`)
- **Severity: warning**
- **Fix**: Insert a space after `:`: `key:` + ` ` + `value`
- **Example**: `name:张三` → `name: 张三`

## Rule 6: Boolean Ambiguity

- **Pattern**: Key-value pair where the value (unquoted) matches: `true`, `false`, `TRUE`, `FALSE`, `True`, `False`, `yes`, `no`, `YES`, `NO`, `Yes`, `No`, `on`, `off`, `ON`, `OFF`, `On`, `Off`, `null`, `NULL`, `Null`, `~`, `.inf`, `.nan`, `.INF`, `.NAN`, `Infinity`, `-Infinity`
- **Severity: warning**
- **Fix**: Wrap the value in quotes. Prefer `"` unless value contains `"` (then use `'`)
- **Regex**: `/^\s*[^#:]+:\s*(.+?)(?:\s*#.*)?$/`
- **Unicode quote stripping**: Also handles `\u2018\u2019\u201C\u201D\u300C\u300D\u300E\u300F\uFF02` (Chinese/Unicode quote marks)

## Rule 7: `#` in Unquoted Value

- **Pattern**: `#` appears after `:` in value area, preceded by space, not inside quotes
- **Detection logic**:
  1. `#` index > colon index
  2. Value between `:` and `#` is non-empty
  3. Character before `#` is a space (YAML treats `# ` as comment start)
  4. The `#` is NOT inside open quotes (check `hasOpenDoubleQuote` / `hasOpenSingleQuote`)
- **Severity: warning**
- **Fix**: Wrap the entire value after `:` in quotes: `${key}: "${value}"`
- **Example**: `desc: 需求编号 #12345` → `desc: "需求编号 #12345"`

## Rule 8: Reserved Characters in Unquoted Value

- **Pattern**: Unquoted key-value value contains any of: `{ } [ ] , & * ! > |`
- **Each character has a description**:
  - `{` — 开花括号通常用于内联映射 (flow mapping)
  - `}` — 闭花括号通常用于内联映射结束
  - `[` — 开方括号通常用于内联序列 (flow sequence)
  - `]` — 闭方括号通常用于内联序列结束
  - `,` — 逗号通常用于分隔内联集合项
  - `&` — & 符号用于定义 YAML 锚点 (anchor)
  - `*` — * 符号用于引用 YAML 别名 (alias)
  - `!` — ! 符号用于声明 YAML 标签 (tag)
  - `>` — > 符号用于折叠块标量 (block scalar)
  - `|` — | 符号用于保留换行的块标量 (literal block scalar)
- **Severity: warning**
- **Fix**: Wrap value in quotes
- **Regex**: `RESERVED_CHARS_PATTERN = /[\[\]{},&*!>|]/`

## Rule 9: Parser-Level Errors (from yaml library)

- **Method**: `YAML.parseAllDocuments(content)` then iterate `doc.errors`
- Falls back to `YAML.parse(content)` in catch block if `parseAllDocuments` throws
- **Severity: error**
- **Fix generation**: Delegated to `generateFixForParseError()` (see fix-strategies.md)
- **Deduplication**: Won't report if the same line already has an `error` from line-by-line checks (e.g., Tab indentation)

## Rule 10: Parser-Level Warnings (from yaml library)

- **Method**: `YAML.parseAllDocuments(content)` then iterate `doc.warnings`
- **Severity: warning**
- **Deduplication**: Won't report if the same line already has a warning with the same message text
- **Fix**: No automatic fix generation
