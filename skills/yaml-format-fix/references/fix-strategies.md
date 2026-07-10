# Fix Strategies Reference

## Fix Generation for Key-Value Issues

### Quote Character Selection Algorithm

When wrapping a value in quotes, follow this priority:

```
1. If value contains BOTH " and ' → wrap in " and escape internal " as \"
2. Else if value contains " → wrap in '
3. Else → wrap in "
```

Implementation pattern:
```typescript
const hasDouble = value.includes('"');
const hasSingle = value.includes("'");
let wrapped: string;
if (hasDouble && hasSingle) {
    wrapped = '"' + value.replace(/"/g, '\\"') + '"';
} else if (hasDouble) {
    wrapped = "'" + value + "'";
} else {
    wrapped = '"' + value + '"';
}
```

### Trailing Whitespace Strip

**Always** trim trailing special whitespace from extracted values before wrapping:

```typescript
let value = seqMatch[2].replace(/[\s\u00A0]+$/, '');
```

This handles:
- `\r` (carriage return, common in files with CRLF line endings)
- `\u00A0` (non-breaking space)
- All standard whitespace (`\s`)

Without this strip, the closing quote may appear on a new line.

## Fix for Parser-Level Errors

### Nested Mapping Error

Triggered by YAML parsing errors containing: `"nested map"`, `"compact map"`, or `"not allowed"`.

**Priority order of matching:**

#### 1. Sequence Item Pattern (MATCH FIRST)

```
Input:   - value_with_{}
Pattern: /^(\s*-\s+)(.+)$/
Action:  Wrap `seqMatch[2]` (the value after "- ") in quotes
```

This must be attempted **before** key:value matching because sequence items with JSON values contain colons internally. Using `indexOf(':')` on a sequence item would find the wrong colon.

Edge case example:
```
- 2、[返回信息检查]{"returnCode": "需确认", "errorMsg": "endDate不能为空"}
```
The nested mapping error triggers at the opening `{`. The fix generator matches the sequence pattern first, strips trailing whitespace from the value, then wraps the entire value in single quotes (because it contains `"`):
```
- '2、[返回信息检查]{"returnCode": "需确认", "errorMsg": "endDate不能为空"}'
```

#### 2. Key:Value Pattern (SECOND)

```
Input:   key: value_with_{}
Pattern: Find first colon (indexOf(':'))
Action:  Split at first colon + skip spaces, wrap value part in quotes
```

Critical: Always use `indexOf(':')` (first colon), **never** `lastIndexOf(':')`. The latter will find colons inside JSON/nested structures.

Edge case example:
```
api_expected: {"returnCode": "需确认", "errorMsg": null}
```
- `indexOf(':')` finds the correct separator (between `api_expected` and the JSON value)
- `lastIndexOf(':')` would find the colon inside the JSON → broken fix

### Missing Closing Quote Error

Triggered by parse errors containing: `"missing closing"` AND `"quote"`.

**Algorithm**: Count quote parity to determine which quote is missing.

```typescript
const singles = lineText.split("'").length - 1;  // count of '
const doubles = (lineText.match(/"/g) || []).length;  // count of "

if (singles % 2 !== 0) { return lineText + "'"; }  // odd → missing closing '
if (doubles % 2 !== 0) { return lineText + '"'; }  // odd → missing closing "
```

This handles mixed-quote scenarios correctly by checking each quote type independently.

### Error Message Truncation

Parser error messages include the source line text after a `\n`. Full source lines can be very long, overflowing VS Code's UI.

**Truncation logic** (`truncateYamlMessage`):
```
1. Split at first \n
2. Keep description before \n
3. Keep up to 80 chars of source after \n, append "…" if truncated
4. Join with " | " separator
```

Output format: `错误描述 at line N, column M: | <first 80 chars of source>`

## Batch Fix Workflow (Fix All)

### Architecture

```
getAllFixes(uri)
    ↓
sort desc (bottom → top, prevents line offset drift)
    ↓
for each batch of 100:
    editor.edit(editBuilder => {
        for each fix in batch:
            if lineIdx out of bounds → skip (count as skipped)
            if oldLine.text === fixedLine → continue (already fixed)
            editBuilder.replace(oldLine.range, fixedLine)
    })
    ↓
    if !applied → break (previous batch failed)
    ↓
    await setTimeout(30) between batches
    ↓
re-validate & publish diagnostics
    ↓
showInformationMessage: "共修复 N 处，剩余 M 处问题"
```

### Key Design Decisions

1. **Line-at-a-time replacement**: Each line gets its own `editBuilder.replace(line.range, fixedLine)`. Do NOT batch lines into a single range replacement — VS Code may silently reject mismatched ranges.

2. **Descending sort**: Processing bottom-to-top ensures fixing higher line numbers doesn't shift the position of lower line numbers still to be processed.

3. **100-line batches**: The VS Code `WorkspaceEdit` has no hard limit for single `editor.edit()` calls, but 100 lines per batch provides a safe margin and keyboard responsiveness.

4. **30ms inter-batch delay**: `await new Promise(r => setTimeout(r, 30))` prevents UI stuttering on large files (2000+ fixes).

5. **Undo behavior**: Only the first batch gets `undoStopBefore: true` (`i === 0`). Subsequent batches use `undoStopAfter: false` so that a single undo reverses all batches.

6. **Skip tracking**: Lines already fixed or out of bounds are tracked via `batchSkipped` for console logging but do NOT break the batch.

### Re-validation After Fix

After all batches complete:

```typescript
const issues = validateYamlContent(editor.document.getText());
publishYamlDiagnostics(uri, issues);
```

This re-validates the in-memory editor content (NOT re-reading from disk), ensuring instant feedback on remaining issues. The toast message shows remaining count: a value of 0 means clean validation.

## Single-Line Fix (Quick Fix via CodeAction)

### Message Cleaning

The diagnostic message is cleaned for the CodeAction menu:
1. Strip `第 N 行：` prefix
2. Strip trailing advice starting with `，如需...`

### WorkspaceEdit Construction

```typescript
const fullLineRange = new vscode.Range(line - 1, 0, line - 1, document.lineAt(line - 1).text.length);
action.edit = new vscode.WorkspaceEdit();
action.edit.replace(document.uri, fullLineRange, fixLine);
```

Uses the current document's line length to set the exact range, ensuring only that line is replaced.
