"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const fs = __importStar(require("fs"));
// Mock fs module
vitest_1.vi.mock('fs', () => ({
    existsSync: vitest_1.vi.fn(),
    readFileSync: vitest_1.vi.fn(),
    writeFileSync: vitest_1.vi.fn(),
    mkdirSync: vitest_1.vi.fn(),
}));
(0, vitest_1.describe)('storage.ts', () => {
    let mockContext;
    let storage;
    (0, vitest_1.beforeEach)(async () => {
        vitest_1.vi.clearAllMocks();
        // 动态导入以使用 mock
        storage = await Promise.resolve().then(() => __importStar(require('./storage')));
        mockContext = {
            globalStoragePath: '/mock/storage/path'
        };
    });
    (0, vitest_1.describe)('getConfigPath', () => {
        (0, vitest_1.it)('应该返回正确的配置文件路径', () => {
            const configPath = storage.getConfigPath(mockContext);
            (0, vitest_1.expect)(configPath).toBe('/mock/storage/path/app-config.json');
        });
    });
    (0, vitest_1.describe)('getQueryParamsPath', () => {
        (0, vitest_1.it)('应该返回正确的查询参数文件路径', () => {
            const paramsPath = storage.getQueryParamsPath(mockContext);
            (0, vitest_1.expect)(paramsPath).toBe('/mock/storage/path/query-params.json');
        });
    });
    (0, vitest_1.describe)('readConfig', () => {
        (0, vitest_1.it)('应该返回默认配置当文件不存在', () => {
            fs.existsSync.mockReturnValue(false);
            const config = storage.readConfig(mockContext);
            (0, vitest_1.expect)(config.apiUrl).toBe('http://127.0.0.1:8081');
            (0, vitest_1.expect)(config.authToken).toBe('');
            (0, vitest_1.expect)(config.userId).toBe('');
            (0, vitest_1.expect)(config.userName).toBe('');
            (0, vitest_1.expect)(config.sm2PublicKey).toBe('');
        });
        (0, vitest_1.it)('应该合并默认配置和已有配置', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({
                apiUrl: 'http://custom.url',
                userId: 'user123'
            }));
            const config = storage.readConfig(mockContext);
            (0, vitest_1.expect)(config.apiUrl).toBe('http://custom.url');
            (0, vitest_1.expect)(config.userId).toBe('user123');
            (0, vitest_1.expect)(config.authToken).toBe(''); // 默认值
        });
        (0, vitest_1.it)('应该在读取失败时返回默认配置', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockImplementation(() => {
                throw new Error('Read error');
            });
            const config = storage.readConfig(mockContext);
            (0, vitest_1.expect)(config.apiUrl).toBe('http://127.0.0.1:8081');
        });
    });
    (0, vitest_1.describe)('writeConfig', () => {
        (0, vitest_1.it)('应该创建目录如果不存在', () => {
            fs.existsSync.mockReturnValue(false);
            fs.readFileSync.mockReturnValue('{}');
            storage.writeConfig(mockContext, { apiUrl: 'http://test.com' });
            (0, vitest_1.expect)(fs.mkdirSync).toHaveBeenCalledWith(mockContext.globalStoragePath, { recursive: true });
        });
        (0, vitest_1.it)('应该写入更新后的配置', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({
                apiUrl: 'http://old.url',
                userId: 'user1'
            }));
            const result = storage.writeConfig(mockContext, { apiUrl: 'http://new.url' });
            (0, vitest_1.expect)(result.apiUrl).toBe('http://new.url');
            (0, vitest_1.expect)(result.userId).toBe('user1');
            (0, vitest_1.expect)(fs.writeFileSync).toHaveBeenCalled();
        });
        (0, vitest_1.it)('应该返回合并后的配置', () => {
            fs.existsSync.mockReturnValue(false);
            const result = storage.writeConfig(mockContext, { userName: 'TestUser' });
            (0, vitest_1.expect)(result.userName).toBe('TestUser');
            (0, vitest_1.expect)(result.apiUrl).toBe('http://127.0.0.1:8081');
        });
    });
    (0, vitest_1.describe)('readParams', () => {
        (0, vitest_1.it)('应该返回默认参数当文件不存在', () => {
            fs.existsSync.mockReturnValue(false);
            const params = storage.readParams(mockContext);
            (0, vitest_1.expect)(params.testTaskNo).toBe('');
            (0, vitest_1.expect)(params.subTestTaskName).toBe('');
            (0, vitest_1.expect)(params.testPhaseName).toBe('');
        });
        (0, vitest_1.it)('应该读取已有的查询参数', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify({
                testTaskNo: 'TASK001',
                subTestTaskName: 'SubTask1',
                testPhaseName: 'Phase1'
            }));
            const params = storage.readParams(mockContext);
            (0, vitest_1.expect)(params.testTaskNo).toBe('TASK001');
            (0, vitest_1.expect)(params.subTestTaskName).toBe('SubTask1');
            (0, vitest_1.expect)(params.testPhaseName).toBe('Phase1');
        });
    });
    (0, vitest_1.describe)('writeParams', () => {
        (0, vitest_1.it)('应该创建目录如果不存在', () => {
            fs.existsSync.mockReturnValue(false);
            storage.writeParams(mockContext, {
                testTaskNo: 'TASK001',
                subTestTaskName: 'SubTask1',
                testPhaseName: 'Phase1'
            });
            (0, vitest_1.expect)(fs.mkdirSync).toHaveBeenCalledWith(mockContext.globalStoragePath, { recursive: true });
        });
        (0, vitest_1.it)('应该写入查询参数', () => {
            fs.existsSync.mockReturnValue(true);
            storage.writeParams(mockContext, {
                testTaskNo: 'TASK001',
                subTestTaskName: 'SubTask1',
                testPhaseName: 'Phase1'
            });
            (0, vitest_1.expect)(fs.writeFileSync).toHaveBeenCalled();
            const writtenContent = fs.writeFileSync.mock.calls[0][1];
            const writtenParams = JSON.parse(writtenContent);
            (0, vitest_1.expect)(writtenParams.testTaskNo).toBe('TASK001');
        });
    });
    (0, vitest_1.describe)('ensureDir', () => {
        (0, vitest_1.it)('应该创建目录如果不存在', () => {
            fs.existsSync.mockReturnValue(false);
            storage.ensureDir(mockContext);
            (0, vitest_1.expect)(fs.mkdirSync).toHaveBeenCalledWith(mockContext.globalStoragePath, { recursive: true });
        });
        (0, vitest_1.it)('如果目录已存在则不创建', () => {
            fs.existsSync.mockReturnValue(true);
            storage.ensureDir(mockContext);
            (0, vitest_1.expect)(fs.mkdirSync).not.toHaveBeenCalled();
        });
    });
});
//# sourceMappingURL=storage.test.js.map