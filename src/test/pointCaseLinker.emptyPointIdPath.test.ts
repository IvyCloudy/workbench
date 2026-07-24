/**
 * pointCaseLinker · pointId 为空字符串时仍能按路径匹配(type=3)
 * ----------------------------------------------------------------------------
 * 验证 buildIndex 对 pointId 为空字符串的要点不再整体跳过：
 *   只要有合法 pointPath,就纳入 byPath 索引,从而 matchCore 可凭路径兜底命中(type=3)。
 * 该测试直接构造 pointId:"" 的 pointList(绕过 md 解析兜底),覆盖更底层的入口。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { linkPointsToCases } from '../utils/pointCaseLinker';
import type { PointItem } from '../utils/pointCaseLinker';

const TMP = path.join(os.tmpdir(), 'tc-empty-pid-path-' + Date.now());

function writeYaml(p: string, rows: string[]): string {
    const f = path.join(TMP, p);
    fs.writeFileSync(f, rows.join('\n'), 'utf-8');
    return f;
}

describe('pointCaseLinker · pointId 为空字符串 → 仍能按路径匹配(type=3)', () => {
    beforeAll(() => fs.mkdirSync(TMP, { recursive: true }));
    afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

    it('pointId 为 "" 且 parent_id 不为空 → 凭 pointPath 命中 type=3', async () => {
        const yaml = writeYaml('c.yaml', [
            '- testcase_id: TC-1',
            '  name: 账号登录案例',
            '  path: 账户中心/登录模块/账号登录',
            '  parent_id: LGN-001',   // 不为空,但 md 侧无此编号 → parent_id 命中失败
        ]);

        const pointList: PointItem[] = [
            { pointId: '', pointName: '账号登录', pointPath: '账户中心/登录模块/账号登录' },
        ];

        const r = await linkPointsToCases(yaml, pointList, { enableCache: false });
        const key = '_账号登录';   // pointId 为空 → pointKey 前缀为空
        expect(r.byPoint[key]).toBeDefined();
        expect(r.byPoint[key][0].type).toBe(3);   // 按路径兜底命中
    });

    it('pointId 为空不进 byId(无编号),但仍进 byPath(可 path 匹配)', async () => {
        const yaml = writeYaml('c2.yaml', [
            '- testcase_id: TC-2a',
            '  name: 账号登录案例',
            '  path: 账户中心/登录模块/账号登录',
            '- testcase_id: TC-2b',
            '  name: 密码错误案例',
            '  path: 账户中心/登录模块/密码错误',
        ]);
        const pointList: PointItem[] = [
            { pointId: '', pointName: '账号登录', pointPath: '账户中心/登录模块/账号登录' },
            { pointId: 'LGN-002', pointName: '密码错误', pointPath: '账户中心/登录模块/密码错误' },
        ];
        const r = await linkPointsToCases(yaml, pointList, { enableCache: false });
        // 空 pointId 要点凭 path 命中
        expect(r.byPoint['_账号登录']?.[0].type).toBe(3);
        // 有编号要点凭 path 命中(type=3)
        expect(r.byPoint['LGN-002_密码错误']).toBeDefined();
        expect(r.byPoint['LGN-002_密码错误'][0].type).toBe(3);
    });

    it('pointId 为空且无合法 pointPath → 不参与任何匹配', async () => {
        const yaml = writeYaml('c3.yaml', [
            '- testcase_id: TC-3',
            '  name: 案例',
            '  path: 某模块/某要点',
        ]);
        const pointList: PointItem[] = [
            { pointId: '', pointName: '残缺要点', pointPath: '' },
        ];
        const r = await linkPointsToCases(yaml, pointList, { enableCache: false });
        expect(Object.keys(r.byPoint).length).toBe(0);
    });
});
