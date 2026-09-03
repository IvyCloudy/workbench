// Mock vscode module for testing
import { vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    file: (path: string) => ({ scheme: 'file', fsPath: path }),
    parse: (uri: string) => ({ scheme: uri.split('://')[0], fsPath: uri }),
  },
  // 全局默认提供一个「已打开工作区」，使 toWorkspaceRelativePath 等依赖
  // workspace.workspaceFolders 的工具函数可用（原先缺此导出会直接抛错）
  workspace: {
    workspaceFolders: [
      { uri: { scheme: 'file', fsPath: '/mock/workspace' }, name: 'mock-workspace', index: 0 },
    ],
    getConfiguration: () => ({ get: (_key: string, defaultValue?: unknown) => defaultValue }),
    asRelativePath: (p: string) => p,
  },
}));
