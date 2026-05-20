import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { AppConfig, QueryParams } from '../types';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe('storage.ts', () => {
  let mockContext: any;
  let storage: typeof import('./storage');

  beforeEach(async () => {
    vi.clearAllMocks();
    // 动态导入以使用 mock
    storage = await import('./storage');
    
    mockContext = {
      globalStoragePath: '/mock/storage/path'
    };
  });

  describe('getConfigPath', () => {
    it('应该返回正确的配置文件路径', () => {
      const configPath = storage.getConfigPath(mockContext);
      expect(configPath).toBe('/mock/storage/path/app-config.json');
    });
  });

  describe('getQueryParamsPath', () => {
    it('应该返回正确的查询参数文件路径', () => {
      const paramsPath = storage.getQueryParamsPath(mockContext);
      expect(paramsPath).toBe('/mock/storage/path/query-params.json');
    });
  });

  describe('readConfig', () => {
    it('应该返回默认配置当文件不存在', () => {
      (fs.existsSync as any).mockReturnValue(false);

      const config = storage.readConfig(mockContext);

      expect(config.apiUrl).toBe('http://127.0.0.1:8081');
      expect(config.authToken).toBe('');
      expect(config.userId).toBe('');
      expect(config.userName).toBe('');
      expect(config.sm2PublicKey).toBe('');
    });

    it('应该合并默认配置和已有配置', () => {
      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(JSON.stringify({
        apiUrl: 'http://custom.url',
        userId: 'user123'
      }));

      const config = storage.readConfig(mockContext);

      expect(config.apiUrl).toBe('http://custom.url');
      expect(config.userId).toBe('user123');
      expect(config.authToken).toBe(''); // 默认值
    });

    it('应该在读取失败时返回默认配置', () => {
      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockImplementation(() => {
        throw new Error('Read error');
      });

      const config = storage.readConfig(mockContext);

      expect(config.apiUrl).toBe('http://127.0.0.1:8081');
    });
  });

  describe('writeConfig', () => {
    it('应该创建目录如果不存在', () => {
      (fs.existsSync as any).mockReturnValue(false);
      (fs.readFileSync as any).mockReturnValue('{}');

      storage.writeConfig(mockContext, { apiUrl: 'http://test.com' });

      expect(fs.mkdirSync).toHaveBeenCalledWith(mockContext.globalStoragePath, { recursive: true });
    });

    it('应该写入更新后的配置', () => {
      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(JSON.stringify({
        apiUrl: 'http://old.url',
        userId: 'user1'
      }));

      const result = storage.writeConfig(mockContext, { apiUrl: 'http://new.url' });

      expect(result.apiUrl).toBe('http://new.url');
      expect(result.userId).toBe('user1');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('应该返回合并后的配置', () => {
      (fs.existsSync as any).mockReturnValue(false);

      const result = storage.writeConfig(mockContext, { userName: 'TestUser' });

      expect(result.userName).toBe('TestUser');
      expect(result.apiUrl).toBe('http://127.0.0.1:8081');
    });
  });

  describe('readParams', () => {
    it('应该返回默认参数当文件不存在', () => {
      (fs.existsSync as any).mockReturnValue(false);

      const params = storage.readParams(mockContext);

      expect(params.testTaskNo).toBe('');
      expect(params.subTestTaskName).toBe('');
      expect(params.testPhaseName).toBe('');
    });

    it('应该读取已有的查询参数', () => {
      (fs.existsSync as any).mockReturnValue(true);
      (fs.readFileSync as any).mockReturnValue(JSON.stringify({
        testTaskNo: 'TASK001',
        subTestTaskName: 'SubTask1',
        testPhaseName: 'Phase1'
      }));

      const params = storage.readParams(mockContext);

      expect(params.testTaskNo).toBe('TASK001');
      expect(params.subTestTaskName).toBe('SubTask1');
      expect(params.testPhaseName).toBe('Phase1');
    });
  });

  describe('writeParams', () => {
    it('应该创建目录如果不存在', () => {
      (fs.existsSync as any).mockReturnValue(false);

      storage.writeParams(mockContext, {
        testTaskNo: 'TASK001',
        subTestTaskName: 'SubTask1',
        testPhaseName: 'Phase1'
      });

      expect(fs.mkdirSync).toHaveBeenCalledWith(mockContext.globalStoragePath, { recursive: true });
    });

    it('应该写入查询参数', () => {
      (fs.existsSync as any).mockReturnValue(true);

      storage.writeParams(mockContext, {
        testTaskNo: 'TASK001',
        subTestTaskName: 'SubTask1',
        testPhaseName: 'Phase1'
      });

      expect(fs.writeFileSync).toHaveBeenCalled();
      const writtenContent = (fs.writeFileSync as any).mock.calls[0][1];
      const writtenParams = JSON.parse(writtenContent);
      expect(writtenParams.testTaskNo).toBe('TASK001');
    });
  });

  describe('ensureDir', () => {
    it('应该创建目录如果不存在', () => {
      (fs.existsSync as any).mockReturnValue(false);

      storage.ensureDir(mockContext);

      expect(fs.mkdirSync).toHaveBeenCalledWith(mockContext.globalStoragePath, { recursive: true });
    });

    it('如果目录已存在则不创建', () => {
      (fs.existsSync as any).mockReturnValue(true);

      storage.ensureDir(mockContext);

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });
  });
});
