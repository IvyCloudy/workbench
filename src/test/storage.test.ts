import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => {
    const mock = {
        existsSync: vi.fn(),
        promises: {
            readFile: vi.fn(),
            writeFile: vi.fn(),
            mkdir: vi.fn(),
        },
    };
    return { ...mock, default: mock };
});

import * as fs from 'fs';
import {
    readConfig,
    writeParams
} from '../services/storage';

const mockedFs = fs as unknown as {
    existsSync: ReturnType<typeof vi.fn>;
    promises: {
        readFile: ReturnType<typeof vi.fn>;
        writeFile: ReturnType<typeof vi.fn>;
        mkdir: ReturnType<typeof vi.fn>;
    };
};

describe('services/storage', () => {
    let mockContext: any;

    beforeEach(() => {
        vi.clearAllMocks();
        mockContext = { globalStoragePath: '/mock/storage/path' };
    });

    describe('readConfig', () => {
        it('文件不存在时返回默认配置', async () => {
            mockedFs.existsSync.mockReturnValue(false);
            const config = await readConfig(mockContext);

            expect(config.apiUrl).toBe('http://127.0.0.1:8081');
            expect(config.authToken).toBe('');
            expect(config.userId).toBe('');
        });

        it('合并默认配置和已有配置', async () => {
            mockedFs.existsSync.mockReturnValue(true);
            mockedFs.promises.readFile.mockResolvedValue(JSON.stringify({
                apiUrl: 'http://custom.url',
                userId: 'user123'
            }));

            const config = await readConfig(mockContext);
            expect(config.apiUrl).toBe('http://custom.url');
            expect(config.userId).toBe('user123');
            expect(config.authToken).toBe('');
        });

        it('读取失败时返回默认配置', async () => {
            mockedFs.existsSync.mockReturnValue(true);
            mockedFs.promises.readFile.mockRejectedValue(new Error('Read error'));

            const config = await readConfig(mockContext);
            expect(config.apiUrl).toBe('http://127.0.0.1:8081');
        });
    });

    describe('writeParams', () => {
        it('写入查询参数', async () => {
            mockedFs.existsSync.mockReturnValue(true);
            await writeParams(mockContext, {
                testTaskNo: 'TASK001',
                subTestTaskName: 'SubTask1',
                testPhaseName: 'Phase1'
            });

            expect(mockedFs.promises.writeFile).toHaveBeenCalled();
            const writtenContent = mockedFs.promises.writeFile.mock.calls[0][1];
            const writtenParams = JSON.parse(writtenContent);
            expect(writtenParams.testTaskNo).toBe('TASK001');
        });
    });
});
