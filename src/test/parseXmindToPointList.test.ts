/**
 * parseXmindToPointList.test.ts
 * ----------------------------------------------------------------------------
 * xmind 测试要点解析器单测（不依赖真实 xmind 文件；用 JSZip 手工构造 fixture）
 *
 * 覆盖用例：
 *   ① 基础：一个五角星测试点 + 完整 pointPath
 *   ② P1 语义：嵌套测试点，祖先五角星节点也进 pointPath
 *   ③ pointId 为空：五角星节点无 label
 *   ④ 多 label 告警：脏数据不阻断
 *   ⑤ 无图标中间节点：E3 报错、一次性列全
 *   ⑥ 说明节点：五角星子树下无图标节点被忽略、不报错
 *   ⑦ 多 sheet：所有 sheet 的测试点合并
 *   ⑧ 游离主题：detached 被跳过
 *   ⑨ 老版本 XML：xmind 8 的 content.xml 也能解析
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseXmindToPointListSilent } from '../utils/parseXmindToPointList';

// ------------------------------------------------------------------
// fixture 构造工具
// ------------------------------------------------------------------

/** 构造一个 ZEN JSON 结构的 topic */
function topic(
    title: string,
    opts: { markers?: string[]; labels?: string[]; children?: any[] } = {},
): any {
    return {
        id: `id-${title}`,
        title,
        markers: (opts.markers || []).map(id => ({ markerId: id })),
        labels: opts.labels || [],
        children: opts.children ? { attached: opts.children } : undefined,
    };
}

/** 把 ZEN 结构数据打包成一个临时 .xmind 文件，返回其路径 */
async function makeZenXmind(sheets: any[]): Promise<string> {
    const zip = new JSZip();
    zip.file('content.json', JSON.stringify(sheets));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const fp = path.join(os.tmpdir(), `xmind-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}.xmind`);
    fs.writeFileSync(fp, buf);
    return fp;
}

/** 把 xmind 8 XML 内容打包成一个临时 .xmind 文件，返回其路径 */
async function makeLegacyXmind(xml: string): Promise<string> {
    const zip = new JSZip();
    zip.file('content.xml', xml);
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const fp = path.join(os.tmpdir(), `xmind-fixture-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.xmind`);
    fs.writeFileSync(fp, buf);
    return fp;
}

// ------------------------------------------------------------------
// 单测
// ------------------------------------------------------------------

describe('parseXmindToPointListSilent', () => {
    it('①基础：一个五角星测试点 + 完整 pointPath', async () => {
        const sheet = {
            title: '画布1',
            rootTopic: topic('中心主题', {
                children: [
                    topic('分支主题1', {
                        markers: ['flag-red'],
                        children: [
                            topic('子主题1', {
                                markers: ['flag-orange'],
                                children: [
                                    topic('测试要点', {
                                        markers: ['star-red'],
                                        labels: ['001'],
                                    }),
                                ],
                            }),
                        ],
                    }),
                ],
            }),
        };
        const fp = await makeZenXmind([sheet]);
        const r = await parseXmindToPointListSilent(fp);
        expect(r.errorMsg).toBe('');
        expect(r.invalidNodes).toEqual([]);
        expect(r.pointList).toEqual([
            { pointId: '001', pointName: '测试要点', pointPath: '分支主题1/子主题1/测试要点' },
        ]);
    });

    it('②P1 语义：嵌套测试点，祖先五角星也进 pointPath', async () => {
        const sheet = {
            title: '画布1',
            rootTopic: topic('中心主题', {
                children: [
                    topic('分支主题1', {
                        markers: ['flag-red'],
                        children: [
                            topic('子主题1', {
                                markers: ['flag-orange'],
                                children: [
                                    topic('测试要点', {
                                        markers: ['star-red'],
                                        labels: ['001'],
                                        children: [
                                            topic('子主题2', {
                                                markers: ['star-red'],
                                            }),
                                        ],
                                    }),
                                ],
                            }),
                        ],
                    }),
                ],
            }),
        };
        const fp = await makeZenXmind([sheet]);
        const r = await parseXmindToPointListSilent(fp);
        expect(r.errorMsg).toBe('');
        expect(r.pointList).toEqual([
            { pointId: '001', pointName: '测试要点', pointPath: '分支主题1/子主题1/测试要点' },
            { pointId: '', pointName: '子主题2', pointPath: '分支主题1/子主题1/测试要点/子主题2' },
        ]);
    });

    it('③pointId 为空：五角星节点无 label', async () => {
        const sheet = {
            title: '画布1',
            rootTopic: topic('root', {
                children: [
                    topic('模块A', {
                        markers: ['flag-red'],
                        children: [
                            topic('无编号测试点', { markers: ['star-red'] }),
                        ],
                    }),
                ],
            }),
        };
        const fp = await makeZenXmind([sheet]);
        const r = await parseXmindToPointListSilent(fp);
        expect(r.errorMsg).toBe('');
        expect(r.pointList).toEqual([
            { pointId: '', pointName: '无编号测试点', pointPath: '模块A/无编号测试点' },
        ]);
    });

    it('④多 label 告警：取首个 + 输出 warnings', async () => {
        const sheet = {
            title: '画布1',
            rootTopic: topic('root', {
                children: [
                    topic('模块A', {
                        markers: ['flag-red'],
                        children: [
                            topic('多标签点', {
                                markers: ['star-red'],
                                labels: ['ID-01', 'ID-02', 'ID-03'],
                            }),
                        ],
                    }),
                ],
            }),
        };
        const fp = await makeZenXmind([sheet]);
        const r = await parseXmindToPointListSilent(fp);
        expect(r.errorMsg).toBe('');
        expect(r.pointList[0].pointId).toBe('ID-01');
        expect(r.warnings.length).toBe(1);
        expect(r.warnings[0].message).toContain('3');
        expect(r.warnings[0].message).toContain('ID-01');
    });

    it('⑤无图标中间节点：E3 报错、一次性列全', async () => {
        const sheet = {
            title: '画布1',
            rootTopic: topic('root', {
                children: [
                    topic('无图标节点A', {
                        children: [
                            topic('无图标节点B', {
                                children: [
                                    topic('测试点', { markers: ['star-red'], labels: ['X'] }),
                                ],
                            }),
                        ],
                    }),
                ],
            }),
        };
        const fp = await makeZenXmind([sheet]);
        const r = await parseXmindToPointListSilent(fp);
        expect(r.errorMsg).toMatch(/xmind 结构错误/);
        expect(r.pointList).toEqual([]); // 结构错误时 pointList 清空
        // 两个无图标中间节点都要出现在清单里
        expect(r.invalidNodes.length).toBe(2);
        expect(r.invalidNodes.map(n => n.title)).toEqual(
            expect.arrayContaining(['无图标节点A', '无图标节点B']),
        );
    });

    it('⑥说明节点：五角星子树下无图标节点被忽略、不报错', async () => {
        const sheet = {
            title: '画布1',
            rootTopic: topic('root', {
                children: [
                    topic('模块A', {
                        markers: ['flag-red'],
                        children: [
                            topic('测试点', {
                                markers: ['star-red'],
                                labels: ['P1'],
                                children: [
                                    topic('测试要点描述', {}),
                                    topic('补充信息', { children: [ topic('深层说明', {}) ] }),
                                ],
                            }),
                        ],
                    }),
                ],
            }),
        };
        const fp = await makeZenXmind([sheet]);
        const r = await parseXmindToPointListSilent(fp);
        expect(r.errorMsg).toBe('');
        expect(r.invalidNodes).toEqual([]);
        expect(r.pointList).toEqual([
            { pointId: 'P1', pointName: '测试点', pointPath: '模块A/测试点' },
        ]);
    });

    it('⑦多 sheet：所有 sheet 的测试点合并', async () => {
        const sheet1 = {
            title: '画布1',
            rootTopic: topic('root1', {
                children: [ topic('模块1', { markers: ['flag-red'], children: [ topic('T1', { markers: ['star-red'], labels: ['A1'] }) ] }) ],
            }),
        };
        const sheet2 = {
            title: '画布2',
            rootTopic: topic('root2', {
                children: [ topic('模块2', { markers: ['flag-red'], children: [ topic('T2', { markers: ['star-red'], labels: ['A2'] }) ] }) ],
            }),
        };
        const fp = await makeZenXmind([sheet1, sheet2]);
        const r = await parseXmindToPointListSilent(fp);
        expect(r.errorMsg).toBe('');
        expect(r.pointList.map(p => p.pointId)).toEqual(['A1', 'A2']);
    });

    it('⑧游离主题：detached 被跳过', async () => {
        // 手工构造 detached 结构
        const sheet: any = {
            title: '画布1',
            rootTopic: {
                id: 'root',
                title: 'root',
                markers: [],
                labels: [],
                children: {
                    attached: [
                        topic('模块A', {
                            markers: ['flag-red'],
                            children: [ topic('T1', { markers: ['star-red'], labels: ['A1'] }) ],
                        }),
                    ],
                    detached: [
                        topic('游离测试点', { markers: ['star-red'], labels: ['SHOULD_NOT_APPEAR'] }),
                    ],
                },
            },
        };
        const fp = await makeZenXmind([sheet]);
        const r = await parseXmindToPointListSilent(fp);
        expect(r.errorMsg).toBe('');
        expect(r.pointList.map(p => p.pointId)).toEqual(['A1']);
    });

    it('⑨老版本 XML：xmind 8 的 content.xml 也能解析', async () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0">
  <sheet id="s1">
    <title>画布1</title>
    <topic id="root">
      <title>中心主题</title>
      <children>
        <topics type="attached">
          <topic id="a">
            <title>分支主题1</title>
            <marker-refs>
              <marker-ref marker-id="flag-red"/>
            </marker-refs>
            <children>
              <topics type="attached">
                <topic id="p">
                  <title>测试要点</title>
                  <marker-refs>
                    <marker-ref marker-id="star-red"/>
                  </marker-refs>
                  <labels>
                    <label>LGN-001</label>
                  </labels>
                </topic>
              </topics>
            </children>
          </topic>
        </topics>
      </children>
    </topic>
  </sheet>
</xmap-content>`;
        const fp = await makeLegacyXmind(xml);
        const r = await parseXmindToPointListSilent(fp);
        expect(r.errorMsg).toBe('');
        expect(r.pointList).toEqual([
            { pointId: 'LGN-001', pointName: '测试要点', pointPath: '分支主题1/测试要点' },
        ]);
    });

    it('⑩非法文件：读取失败或非 zip → 返回 errorMsg', async () => {
        const fp = path.join(os.tmpdir(), `not-a-real-xmind-${Date.now()}.xmind`);
        fs.writeFileSync(fp, 'this is plain text, not a zip');
        const r = await parseXmindToPointListSilent(fp);
        expect(r.errorMsg).toMatch(/合法的 zip/);
        expect(r.pointList).toEqual([]);
    });

    it('⑫XML 多 label 告警：xmind 8 xml 侧同样触发 pointId 取首个 + warnings', async () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0">
  <sheet id="s1">
    <title>画布1</title>
    <topic id="root">
      <title>中心主题</title>
      <children>
        <topics type="attached">
          <topic id="a">
            <title>模块A</title>
            <marker-refs>
              <marker-ref marker-id="flag-red"/>
            </marker-refs>
            <children>
              <topics type="attached">
                <topic id="p">
                  <title>多标签点</title>
                  <marker-refs>
                    <marker-ref marker-id="star-red"/>
                  </marker-refs>
                  <labels>
                    <label>ID-01</label>
                    <label>ID-02</label>
                    <label>ID-03</label>
                  </labels>
                </topic>
              </topics>
            </children>
          </topic>
        </topics>
      </children>
    </topic>
  </sheet>
</xmap-content>`;
        const fp = await makeLegacyXmind(xml);
        const r = await parseXmindToPointListSilent(fp);
        expect(r.errorMsg).toBe('');
        expect(r.pointList[0].pointId).toBe('ID-01');
        expect(r.warnings.length).toBe(1);
        expect(r.warnings[0].message).toContain('3');
        expect(r.warnings[0].message).toContain('ID-01');
    });

    it('⑬空 title 星形节点：产生「pointName 为空」告警，且解析不阻断', async () => {
        const sheet = {
            title: '画布1',
            rootTopic: topic('root', {
                children: [
                    topic('模块A', {
                        markers: ['flag-red'],
                        children: [
                            topic('', { markers: ['star-red'], labels: ['ID-01'] }),
                        ],
                    }),
                ],
            }),
        };
        const fp = await makeZenXmind([sheet]);
        const r = await parseXmindToPointListSilent(fp);
        expect(r.errorMsg).toBe('');
        expect(r.pointList).toHaveLength(1);
        expect(r.pointList[0].pointName).toBe('');
        expect(r.warnings.some(w => w.message.includes('标题为空'))).toBe(true);
    });

    it('⑭结构错误清单硬上限：不再无限增长（保护 Output 面板）', async () => {
        // 构造 250 个无图标中间节点（>200 上限）
        const badChildren: any[] = [];
        for (let i = 0; i < 250; i++) {
            badChildren.push(topic(`无图标节点-${i}`, {}));
        }
        const sheet = {
            title: '画布1',
            rootTopic: topic('root', { children: badChildren }),
        };
        const fp = await makeZenXmind([sheet]);
        const r = await parseXmindToPointListSilent(fp);
        expect(r.errorMsg).toMatch(/xmind 结构错误/);
        // 硬上限 200，不能突破
        expect(r.invalidNodes.length).toBeLessThanOrEqual(200);
        expect(r.invalidNodes.length).toBeGreaterThan(0);
    });

    it('⑪priority-* 不再被识别为测试点（收紧后仅 star-* 才算五角星）', async () => {
        const sheet = {
            title: '画布1',
            rootTopic: topic('root', {
                children: [
                    topic('模块A', {
                        markers: ['flag-red'],
                        children: [
                            // 该节点只带 priority-1，收紧后应被判为「无图标中间节点」
                            topic('数字圆圈节点', { markers: ['priority-1'], labels: ['SHOULD_NOT_APPEAR'] }),
                        ],
                    }),
                ],
            }),
        };
        const fp = await makeZenXmind([sheet]);
        const r = await parseXmindToPointListSilent(fp);
        expect(r.errorMsg).toMatch(/xmind 结构错误/);
        expect(r.pointList).toEqual([]);
        expect(r.invalidNodes.map(n => n.title)).toContain('数字圆圈节点');
    });
});
