/** 按列分隔符拆分表格行内容，忽略转义后的竖线（\|）。与 escapeCell 写入时的转义规则对称。 */
export function splitTableCells(rowContent: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < rowContent.length; i++) {
    const ch = rowContent[i];
    if (ch === '\\' && i + 1 < rowContent.length && rowContent[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}
