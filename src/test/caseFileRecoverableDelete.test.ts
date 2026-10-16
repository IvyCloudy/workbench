import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// 本文件专属 vscode mock：提供 workspace.fs.delete 以模拟"移到回收站"
// （实现上直接 unlink 以验证原位置已空；真实环境由 VS Code 负责移入 OS 回收站）。
vi.mock('vscode', () => ({
    Uri: { file: vi.fn((p: string) => ({ scheme: 'file', fsPath: p, path: p, toString: () => `file://${p}` })) },
    workspace: {
        workspaceFolders: undefined,
        getConfiguration: vi.fn(() => ({ get: vi.fn(() => undefined) })),
        asRelativePath: vi.fn((p: string) => p),
        fs: {
            delete: vi.fn(async (uri: any) => {
                fs.unlinkSync(uri.fsPath);
            }),
        },
    },
}));

vi.mock('../utils/telemetry', () => ({
    TelemetryService: { sendTelemetryEvent: vi.fn(), sendTelemetryErrorEvent: vi.fn() },
}));

import { deleteCaseFileRecoverable } from '../utils/caseFileRecoverableDelete';
import * as vscode from 'vscode';

describe('deleteCaseFileRecoverable · 可恢复删除（F4：复用回收站）', () => {
    it('有 trash 能力时移到回收站（usedTrash=true）、原位置已空', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcr-'));
        const fp = path.join(dir, 'cases.yaml');
        fs.writeFileSync(fp, '- testcase_id: TC1\n  name: a\n');

        const res = await deleteCaseFileRecoverable(fp);

        // 复用了 VS Code 原生 Move to Trash（与"资源管理器直接删除案例文件"一致）
        expect(vscode.workspace.fs.delete).toHaveBeenCalledTimes(1);
        const [uriArg, optsArg] = (vscode.workspace.fs.delete as any).mock.calls[0];
        expect(uriArg.fsPath).toBe(fp);
        expect(optsArg).toEqual({ useTrash: true });
        expect(res.usedTrash).toBe(true);
        expect(res.deleted).toBe(true);
        // 已移出原位置（进回收站），原路径不再存在
        expect(fs.existsSync(fp)).toBe(false);

        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('文件已不存在（ENOENT）→ 视为删除成功，不报错', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcr-'));
        const fp = path.join(dir, 'nope.yaml');

        const res = await deleteCaseFileRecoverable(fp);

        expect(res.deleted).toBe(true);
        expect(res.error).toBeUndefined();

        fs.rmSync(dir, { recursive: true, force: true });
    });
});
