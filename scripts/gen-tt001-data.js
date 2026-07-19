#!/usr/bin/env node
/**
 * ============================================================================
 *  gen-tt001-data.js
 *  一键为 TT001_测试任务1 生成大批量测试数据
 * ----------------------------------------------------------------------------
 *  产物：
 *    - 测试大纲/关联样例_登录模块.md         （100 个测试要点）
 *    - 测试大纲/关联样例_订单模块.md         （100 个测试要点）
 *    - 测试案例/关联样例_login.yaml           （500 条案例）
 *    - 测试案例/关联样例_order.json           （400 条案例）
 *    - 测试案例/关联样例_mixed.csv            （100 条案例）
 *
 *  三种 type 覆盖策略：
 *    - type=1（parent_id ✅ + path ✅）：正常匹配
 *    - type=2（仅 parent_id ✅）        ：故意让 path 与 md 不一致
 *    - type=3（仅 path ✅）             ：parent_id 用不存在的 ID + 保留 path
 *    - 孤儿                             ：parent_id 与 path 都不匹配
 *    - 尾号剥离：随机 30 条带 `-1/-2/-3` 拖尾
 *
 *  用法：
 *    node scripts/gen-tt001-data.js
 * ============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = '/Users/myronliu/yyy/C001_测试/测试任务/TT001_测试任务1';
const DIR_OUTLINE = path.join(ROOT, '测试大纲');
const DIR_CASE    = path.join(ROOT, '测试案例');

// ============================================================================
// 【1】测试要点素材（100 个登录 + 100 个订单）
// ============================================================================
// 登录域场景池（组合出丰富要点）
const LGN_TOPICS = [
    '账号密码登录', '密码错误拦截', '账号不存在', '图形验证码', '短信验证码登录',
    '记住登录状态', '手机号一键登录', '扫码登录', '第三方登录_微信', '第三方登录_QQ',
    '第三方登录_微博', '第三方登录_Google', '第三方登录_Apple', '登录失败次数限制', '账号锁定策略',
    '密码复杂度校验', '密码定期修改', '密码找回_邮箱', '密码找回_短信', '密码强度提示',
    '注册流程校验', '注册协议勾选', '注册用户名唯一性', '注册手机号唯一性', '注册邮箱唯一性',
    'MFA_短信', 'MFA_邮箱', 'MFA_TOTP', 'MFA_硬件Key', '生物识别_指纹',
    '生物识别_面容', 'SSO单点登录', 'SSO登出联动', '会话超时', 'Token刷新',
    '登录风控_异地', '登录风控_异常设备', '登录风控_异常时段', '登录风控_黑名单IP', '登录风控_频次',
    '游客模式', '游客升级注册', '账号切换', '多设备并发登录', '强制下线其他设备',
    '登录审计日志', '登录失败日志', '账号注销申请', '账号注销确认', '账号冻结解冻',
    '子账号登录', '主账号权限继承', '角色权限校验', '权限变更即时生效', '权限降级提示',
    '登录页多语言', '登录页无障碍', '登录页深色模式', '记住账号', '账号历史列表',
    '快速切换账号', '自动登录_客户端', '登录状态跨端同步', '安全键盘_密码输入', '防截屏_密码输入',
    '登录成功埋点', '登录失败埋点', '首次登录引导', '登录页广告位', '登录接口限流',
    '登录接口幂等', '登录接口重试', '异常网络登录', '弱网登录', '登录页加载性能',
    '登录页兼容_Chrome', '登录页兼容_Safari', '登录页兼容_Firefox', '登录页兼容_Edge', '登录页兼容_IE',
    '登录页兼容_iOS', '登录页兼容_Android', '登录页兼容_平板', '登录页兼容_小屏', '登录页兼容_大屏',
    '密码明文切换', '账号复制粘贴', '账号自动填充', '密码自动填充', '第三方绑定管理',
    '第三方解绑', '第三方登录合并账号', '登录后引导完善资料', '首次登录送积分', '生日登录彩蛋',
    '登录页SEO', '登录页CDN加速', '登录接口鉴权', '登录接口签名', '登录接口跨域',
    '登录接口HTTPS强制', '登录接口证书校验', '登录页CSP策略', '登录页XSS防护',
];

// 订单域场景池
const ORD_TOPICS = [
    '创建订单', '取消订单', '修改地址', '优惠券抵扣', '订单查询',
    '订单支付_支付宝', '订单支付_微信', '订单支付_银行卡', '订单支付_余额', '订单支付_组合',
    '订单支付超时', '订单支付失败', '订单退款申请', '订单退款审核', '订单退款到账',
    '订单售后申请', '订单售后审核', '订单售后退货', '订单售后换货', '订单售后补发',
    '订单发货', '订单物流查询', '订单物流轨迹', '订单签收确认', '订单自动确认收货',
    '订单评价', '订单追评', '订单晒图', '订单匿名评价', '订单评价审核',
    '订单积分抵扣', '订单积分获取', '订单会员折扣', '订单满减', '订单满赠',
    '订单秒杀', '订单预售', '订单拼团', '订单砍价', '订单团购',
    '订单发票申请', '订单电子发票', '订单纸质发票', '订单发票抬头', '订单发票税号',
    '订单批量导出', '订单批量打印', '订单批量发货', '订单批量取消', '订单批量退款',
    '订单状态流转', '订单状态回滚', '订单状态异常', '订单状态同步', '订单状态推送',
    '订单库存扣减', '订单库存回滚', '订单库存不足', '订单库存并发', '订单库存预占',
    '订单价格保护', '订单价格实时', '订单价格锁定', '订单价格显示', '订单价格计算',
    '订单风控_下单', '订单风控_支付', '订单风控_退款', '订单风控_黄牛', '订单风控_刷单',
    '订单商品限购', '订单会员限购', '订单区域限购', '订单账号限购', '订单时段限购',
    '订单分单', '订单合单', '订单拆单', '订单改单', '订单撤单',
    '订单跨境', '订单跨境清关', '订单跨境税费', '订单跨境物流', '订单跨境退货',
    '订单虚拟商品', '订单虚拟发货', '订单激活码', '订单卡密', '订单充值',
    '订单预约', '订单预约变更', '订单预约取消', '订单预约提醒', '订单预约到店',
    '订单开票申请', '订单开票状态', '订单开票查询', '订单开票撤回', '订单开票冲红',
    '订单埋点_下单', '订单埋点_支付', '订单埋点_确认', '订单埋点_评价',
];

const PRIORITIES = ['高', '中', '低'];

// ============================================================================
// 【2】构造 pointList
// ============================================================================
function buildPointList(prefix, topics, count, pointPath) {
    const list = [];
    for (let i = 1; i <= count; i++) {
        const pid = `${prefix}-${String(i).padStart(3, '0')}`;
        const topic = topics[(i - 1) % topics.length];
        const suffix = i <= topics.length ? '' : `_场景${Math.floor((i - 1) / topics.length) + 1}`;
        list.push({
            pointId: pid,
            pointName: topic + suffix,
            desc: `${topic}${suffix} 的功能与边界验证`,
            priority: PRIORITIES[i % 3],
            pointPath,
        });
    }
    return list;
}

const LGN_PATH = '账户中心/登录模块';
const ORD_PATH = '交易中心/订单模块';

const lgnPoints = buildPointList('LGN', LGN_TOPICS, 100, LGN_PATH);
const ordPoints = buildPointList('ORD', ORD_TOPICS, 100, ORD_PATH);

// ============================================================================
// 【3】生成两个 md 文件
// ============================================================================
function buildMd(title, pointPath, associatedCaseFiles, points) {
    const header = `# ${title} - 测试要点

## 1. 概述

本文档描述${title}的核心测试要点，用于与测试案例文件 ${associatedCaseFiles.map(f => '`' + f + '`').join(' / ')} 建立关联。

- 功能条目：${pointPath.replace(/\//g, ' / ')}
- 关联字段说明：案例文件中的 \`parent_id\` 与本表 \`序号(pointId)\` 对齐

## 2. 测试点列表

| 序号 | 测试点 | 描述 | 优先级 |
| ---- | ---- | ---- | ---- |
`;
    const rows = points.map(p =>
        `| ${p.pointId} | ${p.pointName} | ${p.desc} | ${p.priority} |`
    ).join('\n');
    const footer = `

## 3. 说明

- 每一行的 **序号** 即公共方法入参 \`pointList[].pointId\`
- **测试点** 即 \`pointList[].pointName\`
- **功能条目/测试要点** 即 \`pointList[].pointPath\`（本文件对应：\`${pointPath}\`）
- 本文件共 ${points.length} 个测试要点，用于大批量匹配性能与准确性验证
`;
    return header + rows + footer;
}

const mdLogin = buildMd(
    '登录模块',
    LGN_PATH,
    ['关联样例_login.yaml', '关联样例_mixed.csv'],
    lgnPoints
);
const mdOrder = buildMd(
    '订单模块',
    ORD_PATH,
    ['关联样例_order.json', '关联样例_mixed.csv'],
    ordPoints
);

fs.writeFileSync(path.join(DIR_OUTLINE, '关联样例_登录模块.md'), mdLogin, 'utf-8');
fs.writeFileSync(path.join(DIR_OUTLINE, '关联样例_订单模块.md'), mdOrder, 'utf-8');
console.log(`✅ 已生成 md：登录模块=${lgnPoints.length}点，订单模块=${ordPoints.length}点`);

// ============================================================================
// 【4】生成 case 记录（按 type 分档）
// ============================================================================
/**
 * @param opts
 *   domain       'login' | 'order'
 *   points       该 domain 的 pointList
 *   otherPath    与目标 path 不同的路径（造 type=2）
 *   counts       { type1, type2, type3, orphan }
 *   idStart      testcase_id 起始序号
 *   stripCount   带尾号剥离的 case 条数（-1/-2/-3）
 */
function buildCases(opts) {
    const { domain, points, otherPath, counts, idStart, stripCount } = opts;
    const results = [];
    let idSeq = idStart;

    const uuidBase = domain === 'login'
        ? 'c8f1a001-0001-4001-8001'
        : (domain === 'order' ? 'e2b3c002-0002-4002-8002' : 'f4d5e003-0003-4003-8003');

    const targetPath = points[0].pointPath;

    // 打乱一下 point 顺序，避免连续同一 point
    const shuffledPoints = points.slice().sort(() => Math.random() - 0.5);

    // -------- type=1：parent_id ✅ + path ✅ --------
    for (let i = 0; i < counts.type1; i++) {
        const p = shuffledPoints[i % shuffledPoints.length];
        const parentId = i < stripCount
            ? `${p.pointId}-${(i % 3) + 1}`   // 前 stripCount 条造尾号剥离
            : p.pointId;
        results.push(makeCase(domain, uuidBase, idSeq++, parentId, targetPath, p.pointName, 'type1'));
    }

    // -------- type=2：parent_id ✅ + path ❌ --------
    for (let i = 0; i < counts.type2; i++) {
        const p = shuffledPoints[i % shuffledPoints.length];
        results.push(makeCase(domain, uuidBase, idSeq++, p.pointId, otherPath, p.pointName, 'type2'));
    }

    // -------- type=3：parent_id ❌ + path ✅ --------
    for (let i = 0; i < counts.type3; i++) {
        // 用 md 里不存在的 pointId：NOPOINT-XXX
        const fakeId = `NOPOINT-${String(idSeq).padStart(4, '0')}`;
        results.push(makeCase(domain, uuidBase, idSeq++, fakeId, targetPath, `疑似 ${domain} 场景 ${i + 1}`, 'type3'));
    }

    // -------- 孤儿：parent_id ❌ + path ❌ --------
    for (let i = 0; i < counts.orphan; i++) {
        results.push(makeCase(domain, uuidBase, idSeq++, `UNKNOWN-${idSeq}`, '未知路径/孤儿', `孤儿case ${i + 1}`, 'orphan'));
    }

    return { records: results, nextId: idSeq };
}

function makeCase(domain, uuidBase, seq, parentId, casePath, pointName, tag) {
    const suffix = String(seq).padStart(9, '0');
    const tid = `${uuidBase}-${suffix}`;
    const priority = PRIORITIES[seq % 3];
    const testType = seq % 2 === 0 ? '手工' : '自动化';
    const caseType = seq % 4 === 0 ? '流程类' : '功能点类';

    // 简单模板：登录/订单案例语义
    const name = `${pointName}_${tag}_${seq}`;
    const description = `${pointName} 的 ${tag} 类型验证（第 ${seq} 条）`;

    return {
        testcase_id: tid,
        parent_id: parentId,
        path: casePath,
        name,
        description,
        preconditions: [
            `环境已就绪 [${tag}]`,
            `依赖账号/订单已准备 seq=${seq}`,
        ],
        steps: [
            {
                id: 1,
                operation: `执行 ${pointName} 主流程`,
                data: [`param_${seq}`],
                ui_expected: [`界面展示 ${pointName} 成功态`],
                api_expected: [`接口返回 200 (seq=${seq})`],
                db_expected: [`数据表状态更新为 done`],
            },
            {
                id: 2,
                operation: `验证 ${pointName} 结果`,
                data: [`assert_${seq}`],
                ui_expected: [`结果页信息正确`],
                api_expected: [],
                db_expected: [],
            },
        ],
        tags: `${domain},${tag}`,
        type: caseType,
        test_type: testType,
        priority,
    };
}

// ============================================================================
// 【5】三个案例文件的分布
// ============================================================================
// 登录 500：350×type1 + 100×type2 + 40×type3 + 10 孤儿
const loginBuild = buildCases({
    domain: 'login',
    points: lgnPoints,
    otherPath: '兼容测试/旧登录页',        // 与 账户中心/登录模块 不同
    counts: { type1: 350, type2: 100, type3: 40, orphan: 10 },
    idStart: 101,
    stripCount: 18,
});

// 订单 400：280×type1 + 80×type2 + 30×type3 + 10 孤儿
const orderBuild = buildCases({
    domain: 'order',
    points: ordPoints,
    otherPath: '交易归档/历史订单',        // 与 交易中心/订单模块 不同
    counts: { type1: 280, type2: 80, type3: 30, orphan: 10 },
    idStart: 101,
    stripCount: 10,
});

// mixed 100：60×type1 + 20×type2 + 15×type3 + 5 孤儿
// mixed 里两个域各取一半，简单起见让 mixed 全部用登录域点做匹配（path=登录）
const mixedBuildA = buildCases({
    domain: 'mixed',
    points: lgnPoints,
    otherPath: '兼容测试/旧登录页',
    counts: { type1: 30, type2: 10, type3: 8, orphan: 3 },
    idStart: 5000,
    stripCount: 2,
});
const mixedBuildB = buildCases({
    domain: 'mixed',
    points: ordPoints,
    otherPath: '交易归档/历史订单',
    counts: { type1: 30, type2: 10, type3: 7, orphan: 2 },
    idStart: 5500,
    stripCount: 2,
});
const mixedRecords = mixedBuildA.records.concat(mixedBuildB.records);

// ============================================================================
// 【6】序列化：YAML / JSON / CSV
// ============================================================================
// —— 简易 YAML 序列化（贴合现有 login.yaml 风格）——
function yamlEscape(s) {
    if (s == null) return '';
    const str = String(s);
    // 含冒号 / # / 引号 / 前后空格 → 加引号
    if (/[:#'"]|^\s|\s$/.test(str)) {
        return `"${str.replace(/"/g, '\\"')}"`;
    }
    return str;
}

function caseToYaml(c) {
    const lines = [];
    lines.push(`- testcase_id: ${c.testcase_id}`);
    lines.push(`  parent_id: ${c.parent_id}`);
    lines.push(`  path: ${yamlEscape(c.path)}`);
    lines.push(`  name: ${yamlEscape(c.name)}`);
    lines.push(`  description: ${yamlEscape(c.description)}`);
    lines.push(`  preconditions:`);
    for (const pc of c.preconditions) lines.push(`    - ${yamlEscape(pc)}`);
    lines.push(`  steps:`);
    for (const step of c.steps) {
        lines.push(`    - id: ${step.id}`);
        lines.push(`      operation: ${yamlEscape(step.operation)}`);
        lines.push(`      data:`);
        for (const d of step.data) lines.push(`        - ${yamlEscape(d)}`);
        lines.push(`      ui_expected:`);
        if (step.ui_expected.length === 0) {
            lines[lines.length - 1] = `      ui_expected: []`;
        } else {
            for (const u of step.ui_expected) lines.push(`        - ${yamlEscape(u)}`);
        }
        lines.push(`      api_expected:`);
        if (step.api_expected.length === 0) {
            lines[lines.length - 1] = `      api_expected: []`;
        } else {
            for (const a of step.api_expected) lines.push(`        - ${yamlEscape(a)}`);
        }
        lines.push(`      db_expected:`);
        if (step.db_expected.length === 0) {
            lines[lines.length - 1] = `      db_expected: []`;
        } else {
            for (const d of step.db_expected) lines.push(`        - ${yamlEscape(d)}`);
        }
    }
    lines.push(`  tags: ${yamlEscape(c.tags)}`);
    lines.push(`  type: ${c.type}`);
    lines.push(`  test_type: ${c.test_type}`);
    lines.push(`  priority: ${c.priority}`);
    return lines.join('\n');
}

const loginYaml = loginBuild.records.map(caseToYaml).join('\n\n') + '\n';
fs.writeFileSync(path.join(DIR_CASE, '关联样例_login.yaml'), loginYaml, 'utf-8');
console.log(`✅ 已生成 login.yaml：${loginBuild.records.length} 条`);

// —— JSON ——
fs.writeFileSync(
    path.join(DIR_CASE, '关联样例_order.json'),
    JSON.stringify(orderBuild.records, null, 2),
    'utf-8'
);
console.log(`✅ 已生成 order.json：${orderBuild.records.length} 条`);

// —— CSV（简化列：testcase_id,parent_id,path,name,description,preconditions,expected,tags,priority）——
function csvEscape(s) {
    if (s == null) return '';
    const str = String(s);
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
}
function caseToCsvRow(c) {
    const pre = c.preconditions.join(' | ');
    const expected = c.steps.map(st =>
        `【${st.operation}】UI:${st.ui_expected.join(';')} API:${st.api_expected.join(';')} DB:${st.db_expected.join(';')}`
    ).join(' || ');
    return [
        c.testcase_id, c.parent_id, c.path, c.name, c.description,
        pre, expected, c.tags, c.priority,
    ].map(csvEscape).join(',');
}
const csvHeader = 'testcase_id,parent_id,path,name,description,preconditions,expected,tags,priority';
const csvBody = mixedRecords.map(caseToCsvRow).join('\n');
fs.writeFileSync(path.join(DIR_CASE, '关联样例_mixed.csv'), csvHeader + '\n' + csvBody + '\n', 'utf-8');
console.log(`✅ 已生成 mixed.csv：${mixedRecords.length} 条`);

// ============================================================================
// 【7】汇总
// ============================================================================
const totalCases = loginBuild.records.length + orderBuild.records.length + mixedRecords.length;
const stats = {
    md: { login: lgnPoints.length, order: ordPoints.length },
    cases: {
        login_yaml: loginBuild.records.length,
        order_json: orderBuild.records.length,
        mixed_csv: mixedRecords.length,
        total: totalCases,
    },
    typeDistribution: {
        login: { type1: 350, type2: 100, type3: 40, orphan: 10, stripped: 18 },
        order: { type1: 280, type2: 80, type3: 30, orphan: 10, stripped: 10 },
        mixed: { type1: 60, type2: 20, type3: 15, orphan: 5, stripped: 4 },
        grand_total: { type1: 690, type2: 200, type3: 85, orphan: 25 },
    },
};
console.log('\n📊 生成完成，汇总：');
console.log(JSON.stringify(stats, null, 2));
