/**
 * pointCaseLinker · 路径比对时尾部斜杠兼容
 * ----------------------------------------------------------------------------
 * 验证：比对两侧（md 侧 pointPath vs 案例侧 path）任意一方带尾部斜杠、另一方不带，
 *   归一化后都应视为同一路径，兼容命中（type=1 / type=2）。
 *   依据：normalizePointPath 的 .replace(/^\/|\/$/g, '') 去除首尾斜杠。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { linkPointsToCases } from '../utils/pointCaseLinker';
import { parseMdToPointListSilent } from '../handlers/linkerDiagnosticHandler';

const TMP_DIR = path.join(os.tmpdir(), 'tc-path-trail-' + Date.now());
const EXPECT_PATH = '账户中心/登录模块/账号登录';

function mdContent(funcLine: string): string {
    return [
        '# 测试大纲',
        funcLine,
        '',
        '| 序号 | 测试点 |',
        '| --- | --- |',
        '| LGN-001 | 账号登录 |',
    ].join('\n');
}

// 案例 path 可带尾 / 或不带；parent_id 决定 type=1 / type=3
function yamlContent(casePath: string, parentId?: string): string {
    const pidLine = parentId ? `  parent_id: ${parentId}` : '';
    return [
        '- testcase_id: TC-001',
        '  name: 账号登录案例',
        pidLine,
        `  path: ${casePath}`,
    ].join('\n');
}

describe('pointCaseLinker · 路径尾部斜杠比对兼容', () => {
    beforeAll(() => {
        fs.mkdirSync(TMP_DIR, { recursive: true });
    });

    afterAll(() => {
        try {
            fs.rmSync(TMP_DIR, { recursive: true, force: true });
        } catch { /* ignore */ }
    });

    it('type=1：案例 path 带尾 /，md 无尾 / → 仍精确命中', async () => {
        const mdPath = path.join(TMP_DIR, 'p1.md');
        const yamlPath = path.join(TMP_DIR, 'c1.yaml');
        // md 功能条目无尾 /
        fs.writeFileSync(mdPath, mdContent('功能条目：账户中心/登录模块'), 'utf-8');
        // 案例 path 带尾 /
        fs.writeFileSync(yamlPath, yamlContent('账户中心/登录模块/账号登录/', 'LGN-001'), 'utf-8');

        const pointList = await parseMdToPointListSilent(mdPath);
        const result = await linkPointsToCases(yamlPath, pointList, { enableCache: false });

        const item = result.byPoint['LGN-001_账号登录']?.[0];
        expect(item).toBeDefined();
        expect(item.type).toBe(1);
        expect(item.casePath).toBe(EXPECT_PATH);
    });

    it('type=1：案例 path 无尾 /，md 功能条目带尾 / → 仍精确命中', async () => {
        const mdPath = path.join(TMP_DIR, 'p2.md');
        const yamlPath = path.join(TMP_DIR, 'c2.yaml');
        // md 功能条目带尾 /
        fs.writeFileSync(mdPath, mdContent('功能条目：账户中心/登录模块/'), 'utf-8');
        // 案例 path 无尾 /
        fs.writeFileSync(yamlPath, yamlContent('账户中心/登录模块/账号登录', 'LGN-001'), 'utf-8');

        const pointList = await parseMdToPointListSilent(mdPath);
        const result = await linkPointsToCases(yamlPath, pointList, { enableCache: false });

        const item = result.byPoint['LGN-001_账号登录']?.[0];
        expect(item).toBeDefined();
        expect(item.type).toBe(1);
        expect(item.casePath).toBe(EXPECT_PATH);
    });

    it('type=2：parent_id 缺失，仅靠 path 兜底，尾 / 有无兼容', async () => {
        const mdPath = path.join(TMP_DIR, 'p3.md');
        const yamlPath = path.join(TMP_DIR, 'c3.yaml');
        fs.writeFileSync(mdPath, mdContent('功能条目：账户中心/登录模块'), 'utf-8');
        // 无 parent_id，path 带尾 /
        fs.writeFileSync(yamlPath, yamlContent('账户中心/登录模块/账号登录/', undefined), 'utf-8');

        const pointList = await parseMdToPointListSilent(mdPath);
        const result = await linkPointsToCases(yamlPath, pointList, { enableCache: false });

        const item = result.byPoint['LGN-001_账号登录']?.[0];
        expect(item).toBeDefined();
        expect(item.type).toBe(2);
        expect(item.casePath).toBe(EXPECT_PATH);
    });

    it('两侧都带尾 / 与两侧都不带 → 命中结果完全一致', async () => {
        const mdPath = path.join(TMP_DIR, 'p4.md');
        fs.writeFileSync(mdPath, mdContent('功能条目：账户中心/登录模块/'), 'utf-8');
        const pointList = await parseMdToPointListSilent(mdPath);

        const yBoth = path.join(TMP_DIR, 'cBoth.yaml');
        const yNone = path.join(TMP_DIR, 'cNone.yaml');
        fs.writeFileSync(yBoth, yamlContent('账户中心/登录模块/账号登录/', 'LGN-001'), 'utf-8');
        fs.writeFileSync(yNone, yamlContent('账户中心/登录模块/账号登录', 'LGN-001'), 'utf-8');

        const rBoth = await linkPointsToCases(yBoth, pointList, { enableCache: false });
        const rNone = await linkPointsToCases(yNone, pointList, { enableCache: false });

        expect(rBoth.byPoint['LGN-001_账号登录'][0].type).toBe(1);
        expect(rNone.byPoint['LGN-001_账号登录'][0].type).toBe(1);
        expect(rBoth.byPoint['LGN-001_账号登录'][0].casePath)
            .toBe(rNone.byPoint['LGN-001_账号登录'][0].casePath);
    });
});
