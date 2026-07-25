/**
 * pointCaseLinker 真实样例集成验证
 * 目标：用 /Users/myronliu/yyy/C001_测试/测试任务/TT001_测试任务1/ 下的
 *      测试要点(md) + 测试案例(yaml/json/csv) 做端到端联调，验证：
 *      1) 三种案例格式都能被正确解析并匹配
 *      2) type=1 / type=2 / type=3 三种匹配都能产生
 *      3) 末尾 -数字 剥离在真实数据上生效
 *      4) 孤儿案例被识别
 *      5) 缓存命中（二次调用耗时不高于首次）
 *
 * 数据说明：本套件依赖大批量生成数据（登录/订单各 100 点，案例合计 1000 条）。
 * 若样例文件不存在则自动跳过。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { linkPointsToCasesBatch, clearLinkerCache, type PointItem } from '../utils/pointCaseLinker';

const ROOT = '/Users/myronliu/yyy/C001_测试/测试任务/TT001_测试任务1';
const FILES = {
  login: `${ROOT}/测试案例/关联样例_login.yaml`,
  order: `${ROOT}/测试案例/关联样例_order.json`,
  mixed: `${ROOT}/测试案例/关联样例_mixed.csv`,
};
const MDS = {
  login: `${ROOT}/测试大纲/关联样例_登录模块.md`,
  order: `${ROOT}/测试大纲/关联样例_订单模块.md`,
};

const allExist = [...Object.values(FILES), ...Object.values(MDS)].every(fs.existsSync);

/** 从测试要点 md 中解析出 pointList（本地简版解析器） */
function parseMdPointList(mdPath: string): PointItem[] {
  const text = fs.readFileSync(mdPath, 'utf-8');
  const lines = text.split(/\r?\n/);
  let pointPath = '';
  for (const line of lines) {
    const m = line.match(/功能条目\s*[:：]\s*(.+?)\s*$/);
    if (m) { pointPath = m[1].replace(/\s*[/／]\s*/g, '/').trim(); break; }
  }
  if (!pointPath) pointPath = path.basename(mdPath, path.extname(mdPath));
  const result: PointItem[] = [];
  let inTable = false; let idIdx = -1; let nameIdx = -1;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('|')) { inTable = false; idIdx = -1; nameIdx = -1; continue; }
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|');
    if (!inTable) {
      const idI = cells.findIndex(c => /^(序号|id|pointId)$/i.test(c.trim()));
      const nameI = cells.findIndex(c => /^(测试点|测试要点|name|pointName)$/i.test(c.trim()));
      if (idI >= 0 && nameI >= 0) { inTable = true; idIdx = idI; nameIdx = nameI; }
      continue;
    }
    if (cells.every(c => /^:?-+:?$/.test(c.trim()))) continue;
    const pid = (cells[idIdx] || '').trim();
    const pname = (cells[nameIdx] || '').trim();
    if (!pid || !pname) continue;
    result.push({ pointId: pid, pointName: pname, pointPath });
  }
  return result;
}

describe.skipIf(!allExist)('pointCaseLinker · 真实样例集成验证', () => {
  it('批量匹配 1000 条真实案例：type1/2/3 均命中、剥离生效、孤儿被识别、缓存起作用', async () => {
    clearLinkerCache();

    const lgnPoints = parseMdPointList(MDS.login);
    const ordPoints = parseMdPointList(MDS.order);
    const pointList = lgnPoints.concat(ordPoints);
    // 点位数量：允许样例文件被增删，仅要求达到最小规模（登录/订单各 ≥100 点）
    expect(lgnPoints.length).toBeGreaterThanOrEqual(100);
    expect(ordPoints.length).toBeGreaterThanOrEqual(100);
    expect(pointList.length).toBe(lgnPoints.length + ordPoints.length);

    const t0 = Date.now();
    const result = await linkPointsToCasesBatch(Object.values(FILES), pointList);
    const cost = Date.now() - t0;

    console.log('\n════════ 集成验证报告 ════════');
    let grandTotal = 0, grandMatched = 0, grandOrphan = 0, grandStripped = 0;
    const grandType = { type1: 0, type2: 0, type3: 0 };
    for (const [fp, r] of Object.entries(result)) {
      const fname = fp.split('/').pop();
      console.log(`  ${fname}: total=${r.stats.totalRecords} matched=${r.stats.matchedRecords} orphan=${r.stats.orphanRecords} stripped=${r.stats.strippedParentIds} type1=${r.stats.matchedByType.type1} type2=${r.stats.matchedByType.type2} type3=${r.stats.matchedByType.type3}`);
      grandTotal += r.stats.totalRecords;
      grandMatched += r.stats.matchedRecords;
      grandOrphan += r.stats.orphanRecords;
      grandStripped += r.stats.strippedParentIds;
      grandType.type1 += r.stats.matchedByType.type1;
      grandType.type2 += r.stats.matchedByType.type2;
      grandType.type3 += r.stats.matchedByType.type3;
    }
    console.log(`  合计: total=${grandTotal} matched=${grandMatched} orphan=${grandOrphan} stripped=${grandStripped} type1=${grandType.type1} type2=${grandType.type2} type3=${grandType.type3}`);
    console.log(`  首次耗时=${cost}ms`);

    // 二次调用验证缓存
    const t1 = Date.now();
    await linkPointsToCasesBatch(Object.values(FILES), pointList);
    const cost2 = Date.now() - t1;
    console.log(`  二次耗时（缓存）=${cost2}ms`);
    console.log('════════════════════════════════\n');

    const login = result[FILES.login];
    const order = result[FILES.order];
    const mixed = result[FILES.mixed];

    // ---- 断言 ----
    // 1) 总记录数达到最小规模（允许样例文件被增删，历史基线为 1000）
    expect(grandTotal).toBeGreaterThanOrEqual(1000);
    // 2) 三种 type 都必须命中
    expect(grandType.type1).toBeGreaterThan(0);
    expect(grandType.type2).toBeGreaterThan(0);
    expect(grandType.type3).toBeGreaterThan(0);
    // 3) 匹配数 + 孤儿数 == 总数
    expect(grandMatched + grandOrphan).toBe(grandTotal);
    // 4) 尾号剥离生效
    expect(grandStripped).toBeGreaterThan(0);
    // 5) 每个文件都必须有孤儿（脏数据兜底能力）
    expect(login.stats.orphanRecords).toBeGreaterThan(0);
    expect(order.stats.orphanRecords).toBeGreaterThan(0);
    expect(mixed.stats.orphanRecords).toBeGreaterThan(0);
    // 6) 每个文件的 byPoint 都不为空
    expect(Object.keys(login.byPoint).length).toBeGreaterThan(0);
    expect(Object.keys(order.byPoint).length).toBeGreaterThan(0);
    expect(Object.keys(mixed.byPoint).length).toBeGreaterThan(0);
    // 7) 缓存命中：二次调用不慢于首次
    expect(cost2).toBeLessThanOrEqual(cost);
  }, 30000);
});
