"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Mock vscode module for testing
const vitest_1 = require("vitest");
vitest_1.vi.mock('vscode', () => ({
    Uri: {
        file: (path) => ({ scheme: 'file', fsPath: path }),
        parse: (uri) => ({ scheme: uri.split('://')[0], fsPath: uri }),
    },
}));
//# sourceMappingURL=setup.js.map