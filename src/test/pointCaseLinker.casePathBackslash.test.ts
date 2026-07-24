/**
 * pointCaseLinker · 案例 path 字段用反斜杠 \ 作分隔符的兼容验证
 * ----------------------------------------------------------------------------
 * 验证：案例记录 path 字段即使写成 Windows 风格的反斜杠（账户中心\登录模块\账号登录），
 *   - 匹配侧 normalizePointPath 将其转 /，可与 md 侧 pointPath 精确命中 type=1
 *   - 落库的 casePath 也归一化为「/ 分隔、无首尾斜杠」标准形式，与 md 侧展示一致
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { linkPointsToCases } from '../utils/pointCaseLinker';
import { parseMdToPointListSilent } from '../handlers/linkerDiagnosticHandler';

const TMP_DIR = path.join(os.tmpdir(), 'tc-case-path-bs-' + Date.now());
const FUNC_LINE = '功能条目：账户中心\\登录模块\\';
const EXPECT_PATH = '账户中心/登录模块/账号登录';

function mdContent(): string {
    return [
        '# 测试大纲',
        FUNC_LINE,
        '',
        '| 序号 | 测试点 |',
        '| --- | --- |',
        '| LGN-001 | 账号登录 |',
    ].join('\n');
}

function yamlContent(casePath: string): string {
    return [
        '- testcase_id: TC-001',
        '  name: 账号登录案例',
        '  parent_id: LGN-001',
        `  path: ${casePath}`,
    ].join('\n');
}

describe('pointCaseLinker · 案例 path 反斜杠兼容', () => {
    beforeAll(() => {
        fs.mkdirSync(TMP_DIR, { recursive: true });
    });

    afterAll(() => {
        try {
            fs.rmSync(TMP_DIR, { recursive: true, force: true });
        } catch { /* ignore */ }
    });

    it('案例 path 用 \\ 分隔 → type=1 命中且 casePath 归一化为 /', async () => {
        const mdPath = path.join(TMP_DIR, 'point.md');
        const yamlPath = path.join(TMP_DIR, 'case.yaml');
        fs.writeFileSync(mdPath, mdContent(), 'utf-8');
        // 案例 path 故意用反斜杠
        fs.writeFileSync(yamlPath, yamlContent('账户中心\\登录模块\\账号登录'), 'utf-8');

        const pointList = await parseMdToPointListSilent(mdPath);
        expect(pointList.length).toBe(1);
        expect(pointList[0].pointPath).toBe(EXPECT_PATH);

        const result = await linkPointsToCases(yamlPath, pointList, { enableCache: false });
        const key = 'LGN-001_账号登录';
        expect(result.byPoint[key]).toBeDefined();
        expect(result.byPoint[key].length).toBe(1);

        const item = result.byPoint[key][0];
        expect(item.type).toBe(1);                       // 归一化 path 相等 + parent_id 命中
        expect(item.casePath).toBe(EXPECT_PATH);         // 落库也归一化，无反斜杠
    });

    it('案例 path 用 \\ 且尾部多余 \\ → 与标准 / 写法命中同一结果', async () => {
        const mdPath = path.join(TMP_DIR, 'point2.md');
        const yamlA = path.join(TMP_DIR, 'caseA.yaml');
        const yamlB = path.join(TMP_DIR, 'caseB.yaml');
        fs.writeFileSync(mdPath, mdContent(), 'utf-8');
        fs.writeFileSync(yamlA, yamlContent('账户中心\\登录模块\\账号登录\\'), 'utf-8'); // 尾部多 \
        fs.writeFileSync(yamlB, yamlContent('账户中心/登录模块/账号登录'), 'utf-8');     // 标准 /

        const pointList = await parseMdToPointListSilent(mdPath);
        const ra = await linkPointsToCases(yamlA, pointList, { enableCache: false });
        const rb = await linkPointsToCases(yamlB, pointList, { enableCache: false });

        const key = 'LGN-001_账号登录';
        expect(ra.byPoint[key][0].type).toBe(1);
        expect(rb.byPoint[key][0].type).toBe(1);
        expect(ra.byPoint[key][0].casePath).toBe(rb.byPoint[key][0].casePath);
        expect(ra.byPoint[key][0].casePath).toBe(EXPECT_PATH);
    });
});
