// Mock vscode module for testing
import { vi } from 'vitest';

vi.mock('vscode', () => ({
  Uri: {
    file: (path: string) => ({ scheme: 'file', fsPath: path }),
    parse: (uri: string) => ({ scheme: uri.split('://')[0], fsPath: uri }),
  },
}));
