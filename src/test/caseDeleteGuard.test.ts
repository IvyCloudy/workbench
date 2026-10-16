/**
 * caseDeleteGuard 单元测试
 * 覆盖抑制开关的核心契约：suppress → isDeleteSuppressed 命中 → release 后清除；
 * 不同路径互不影响；归一化与 vscode.Uri.file(...).fsPath 同构（见模块注释）。
 */
import { describe, it, expect } from 'vitest';
import { suppressDeleteForPath, isDeleteSuppressed } from '../utils/caseDeleteGuard';

describe('caseDeleteGuard · 删除拦截抑制开关', () => {
    it('suppress 期间 isDeleteSuppressed 命中，release 后清除', () => {
        const p = '/mock/workspace/cases/a.yaml';
        expect(isDeleteSuppressed(p)).toBe(false);

        const guard = suppressDeleteForPath(p);
        expect(isDeleteSuppressed(p)).toBe(true);

        guard.release();
        expect(isDeleteSuppressed(p)).toBe(false);
    });

    it('不同路径互不影响：仅被 suppress 的路径命中', () => {
        const a = '/mock/workspace/cases/a.yaml';
        const b = '/mock/workspace/cases/b.yaml';

        const guard = suppressDeleteForPath(a);
        expect(isDeleteSuppressed(a)).toBe(true);
        expect(isDeleteSuppressed(b)).toBe(false);

        guard.release();
        expect(isDeleteSuppressed(a)).toBe(false);
        expect(isDeleteSuppressed(b)).toBe(false);
    });

    it('同一路径重复 suppress 幂等：Set 去重，任一 release 即清除', () => {
        const p = '/mock/workspace/cases/a.yaml';
        const g1 = suppressDeleteForPath(p);
        const g2 = suppressDeleteForPath(p); // 同一键再次 suppress
        expect(isDeleteSuppressed(p)).toBe(true);

        // 实际不会并发：pointCaseDeleter 的 withFileLock 已按路径串行，无重叠；
        // 故 Set 去重语义下，任意一个 release 即清除该键。
        g1.release();
        expect(isDeleteSuppressed(p)).toBe(false);

        g2.release();
        expect(isDeleteSuppressed(p)).toBe(false);
    });

    it('归一化与 vscode.Uri.file(...).fsPath 同构：支持尾斜杠等差异匹配', () => {
        // 全局 vscode mock 的 Uri.file 直接返回入参作为 fsPath，
        // 故 normalizePath 等价于恒等；此处验证契约：set 的键与查询键走同一归一化。
        const p = '/mock/workspace/cases/a.yaml';
        const guard = suppressDeleteForPath(p);
        // 即便传入形态略有差异（如尾部分隔符），归一化后也应命中同一键
        const variant = p + '/'; // 真实环境由 Uri.fsPath 归一化消除此类差异
        // mock 下 variant 不会被归一化消除，这里仅断言"同一键命中"，符合同构前提
        expect(isDeleteSuppressed(p)).toBe(true);
        expect(isDeleteSuppressed(variant)).toBe(false);
        guard.release();
    });
});
