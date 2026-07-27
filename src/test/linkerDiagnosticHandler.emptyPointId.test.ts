/**
 * linkerDiagnosticHandler · pointId 为空的测试要点也支持查看关联案例
 * ----------------------------------------------------------------------------
 * 验证：md 表格中「序号/编号」列为空时，测试要点不再被丢弃，而是以测试点名称兜底
 *   进入 pointList，并凭借 pointPath 参与 path 匹配（type=2），从而可查看关联案例。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseMdToPointListSilent } from '../handlers/linkerDiagnosticHandler';
import { linkPointsToCases } from '../utils/pointCaseLinker';

const TMP_DIR = path.join(os.tmpdir(), 'tc-empty-pid-' + Date.now());

function mdContent(funcLine: string, rows: string[]): string {
    return [
        '# 测试大纲',
        funcLine,
        '',
        '| 序号 | 测试点 |',
        '| --- | --- |',
        ...rows,
    ].join('\n');
}

describe('linkerDiagnosticHandler · pointId 为空的测试要点也支持查看关联案例', () => {
    beforeAll(() => {
        fs.mkdirSync(TMP_DIR, { recursive: true });
    });
    afterAll(() => {
        try {
            fs.rmSync(TMP_DIR, { recursive: true, force: true });
        } catch { /* ignore */ }
    });

    it('序号列为空 → 测试点以名称兜底进入 pointList（不再被跳过）', async () => {
        const mdPath = path.join(TMP_DIR, 'emptyPid.md');
        fs.writeFileSync(mdPath, mdContent('功能条目：账户中心/登录模块', [
            '|  | 账号登录 |',
            '| LGN-002 | 密码错误 |',
        ]), 'utf-8');

        const list = await parseMdToPointListSilent(mdPath);
        expect(list.length).toBe(2);

        const emptyOne = list.find(p => p.pointName === '账号登录')!;
        expect(emptyOne).toBeDefined();
        expect(emptyOne.pointId).toBe('账号登录');   // pointId 空 → 以测试点名称兜底
        expect(emptyOne.pointPath).toBe('账户中心/登录模块/账号登录');
    });

    it('pointId 为空也能通过 path 匹配案例（type=2）查看关联案例', async () => {
        const mdPath = path.join(TMP_DIR, 'emptyPid2.md');
        const yamlPath = path.join(TMP_DIR, 'case.yaml');
        fs.writeFileSync(mdPath, mdContent('功能条目：账户中心/登录模块', ['|  | 账号登录 |']), 'utf-8');
        fs.writeFileSync(yamlPath, [
            '- testcase_id: TC-001',
            '  name: 账号登录案例',
            '  path: 账户中心/登录模块/账号登录',
        ].join('\n'), 'utf-8');

        const list = await parseMdToPointListSilent(mdPath);
        expect(list.length).toBe(1);

        const result = await linkPointsToCases(yamlPath, list, { enableCache: false });
        const key = '账号登录_账号登录';
        expect(result.byPoint[key]).toBeDefined();
        expect(result.byPoint[key][0].type).toBe(2);   // 仅靠 path 兜底命中
    });

    it('混合：部分有编号、部分无编号，全部进入 pointList', async () => {
        const mdPath = path.join(TMP_DIR, 'mixed.md');
        fs.writeFileSync(mdPath, mdContent('功能条目：账户中心/登录模块', [
            '| LGN-001 | 账号登录 |',
            '|  | 密码错误 |',
            '|  | 退出登录 |',
        ]), 'utf-8');

        const list = await parseMdToPointListSilent(mdPath);
        expect(list.length).toBe(3);
        expect(list.map(p => p.pointId)).toEqual(['LGN-001', '密码错误', '退出登录']);
    });
});
