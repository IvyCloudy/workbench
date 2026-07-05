import * as path from 'path';
import * as vscode from 'vscode';

/** 路径中须包含该目录名（测试大纲） */
export const TEST_OUTLINE_DIR_NAME = '测试大纲';

/** 文件名须以此之一结尾（区分大小写） */
export const POINTS_MD_SUFFIX_REGEX = /(?:point\.md|测试要点\.md|测试点\.md)$/;

export function isPointsMarkdownUri(uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file') {
    return false;
  }
  const segments = uri.fsPath.split(path.sep);
  if (!segments.includes(TEST_OUTLINE_DIR_NAME)) {
    return false;
  }
  return POINTS_MD_SUFFIX_REGEX.test(path.basename(uri.fsPath));
}

export function isPointsMarkdownDocument(document: vscode.TextDocument): boolean {
  return isPointsMarkdownUri(document.uri);
}

export function getPointsMarkdownDescription(): string {
  return `「${TEST_OUTLINE_DIR_NAME}」目录下、且以 point.md / 测试要点.md / 测试点.md 结尾的文件`;
}

function getUriFromTabInput(input: vscode.Tab['input'] | undefined): vscode.Uri | undefined {
  if (!input) {
    return undefined;
  }
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
    return input.uri;
  }
  return undefined;
}

/** 从命令参数、文本编辑器或当前标签解析测试点 md URI */
export function resolvePointsMarkdownUri(resource?: vscode.Uri): vscode.Uri | undefined {
  if (resource && isPointsMarkdownUri(resource)) {
    return resource;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && isPointsMarkdownDocument(editor.document)) {
    return editor.document.uri;
  }
  const tabUri = getUriFromTabInput(vscode.window.tabGroups.activeTabGroup?.activeTab?.input);
  if (tabUri && isPointsMarkdownUri(tabUri)) {
    return tabUri;
  }
  return undefined;
}
