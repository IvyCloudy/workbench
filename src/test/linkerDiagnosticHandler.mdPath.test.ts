/**
 * linkerDiagnosticHandler · md 功能条目路径归一化兼容验证
 * ----------------------------------------------------------------------------
 * 规则：每行 pointPath = 功能条目前缀 用 '/' 拼接 测试点名称，再整体归一化。
 * 验证多种 功能条目 写法都能得到同一标准串（与案例侧 path 同构）：
 *         - 反斜杠 \（Windows 风格）
 *         - 全角斜杠 ／、间隔点 ·
 *         - 尾部缺 / 或多余 /
 *         - 分隔符两侧多余空格
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseMdToPointListSilent } from '../handlers/linkerDiagnosticHandler';

const TMP_DIR = path.join(os.tmpdir(), 'tc-linker-md-path-' + Date.now());

const PREFIX = '账户中心/登录模块';

// 不同写法的 功能条目 行，期望都归一化为 PREFIX
const CASES: { name: string; line: string }[] = [
    { name: '标准正斜杠', line: '功能条目：账户中心/登录模块' },
    { name: '尾部缺斜杠', line: '功能条目：账户中心/登录模块' },
    { name: '尾部多余斜杠', line: '功能条目：账户中心/登录模块/' },
    { name: '反斜杠', line: '功能条目：账户中心\\登录模块' },
    { name: '尾部反斜杠', line: '功能条目：账户中心\\登录模块\\' },
    { name: '全角斜杠', line: '功能条目：账户中心／登录模块' },
    { name: '间隔点', line: '功能条目：账户中心·登录模块' },
    { name: '分隔符两侧空格', line: '功能条目：账户中心 / 登录模块' },
    { name: '中文冒号', line: '功能条目:账户中心/登录模块' },
];

// 表格中的测试点名称
const POINT_NAMES = ['账号登录', '密码错误'];

function mdContent(funcLine: string): string {
    return [
        '# 测试大纲',
        funcLine,
        '',
        '| 序号 | 测试点 |',
        '| --- | --- |',
        '| LGN-001 | 账号登录 |',
        '| LGN-002 | 密码错误 |',
    ].join('\n');
}

describe('linkerDiagnosticHandler · md 功能条目路径归一化兼容', () => {
    beforeAll(() => {
        fs.mkdirSync(TMP_DIR, { recursive: true });
    });

    afterAll(() => {
        try {
            fs.rmSync(TMP_DIR, { recursive: true, force: true });
        } catch { /* ignore */ }
    });

    for (const c of CASES) {
        it(`「${c.name}」应归一化为 ${PREFIX}/<测试点名称>`, async () => {
            const mdPath = path.join(TMP_DIR, `case_${c.name}.md`);
            fs.writeFileSync(mdPath, mdContent(c.line), 'utf-8');

            const pointList = await parseMdToPointListSilent(mdPath);
            expect(pointList.length).toBe(POINT_NAMES.length);
            // 每个点的 pointPath = PREFIX/测试点名称
            pointList.forEach((p, i) => {
                expect(p.pointName).toBe(POINT_NAMES[i]);
                expect(p.pointPath).toBe(`${PREFIX}/${POINT_NAMES[i]}`);
            });
        });
    }

    it('不同写法（反斜杠+尾斜杠 vs 标准）应得到完全相同的 pointPath 集合', async () => {
        const a = path.join(TMP_DIR, 'a.md');
        const b = path.join(TMP_DIR, 'b.md');
        fs.writeFileSync(a, mdContent('功能条目：账户中心\\登录模块\\'), 'utf-8');
        fs.writeFileSync(b, mdContent('功能条目：账户中心/登录模块'), 'utf-8');

        const pa = await parseMdToPointListSilent(a);
        const pb = await parseMdToPointListSilent(b);
        expect(pa.map(p => p.pointPath)).toEqual(pb.map(p => p.pointPath));
        expect(pa.map(p => p.pointPath)).toEqual(POINT_NAMES.map(n => `${PREFIX}/${n}`));
    });
});
