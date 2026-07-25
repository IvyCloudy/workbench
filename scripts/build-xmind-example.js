/**
 * scripts/build-xmind-example.js
 * ----------------------------------------------------------------------------
 * 一次性脚本：按 parseXmindToPointList.ts 的解析规则，生成一个合法且覆盖多场景的
 * .xmind 示例文件到指定路径。
 *
 * 结构（覆盖场景）：
 *   中心主题：账户中心（根，不进 path，豁免图标）
 *     └─ 🚩 登录模块（flag）
 *         ├─ 🚩 账号密码登录组（flag）
 *         │   ├─ ⭐ 账号密码登录 [LGN-001]（priority）
 *         │   ├─ ⭐ 密码错误拦截 [LGN-002]
 *         │   └─ ⭐ 账号不存在 [LGN-003]
 *         ├─ 🚩 验证码相关（flag）
 *         │   ├─ ⭐ 图形验证码 [LGN-004]
 *         │   │   └─ 场景说明：应支持刷新     ← 说明节点（无图标，处于星形子树下 → 忽略）
 *         │   └─ ⭐ 短信验证码登录 [LGN-005]
 *         ├─ 🚩 第三方登录（flag）
 *         │   ├─ ⭐ 扫码登录 [LGN-008]
 *         │   │   └─ ⭐ 扫码登录_异常场景（嵌套测试点，无 label 走 type=3 兜底）
 *         │   ├─ ⭐ 第三方登录_微信 [LGN-009]
 *         │   └─ ⭐ 第三方登录_QQ [LGN-010]
 *         └─ 🚩 会话与Token（flag）
 *             ├─ ⭐ 会话超时 [LGN-034]
 *             └─ ⭐ Token刷新 [LGN-035]
 *
 *   预期解析出的 pointList（示例，实际按规则计算）：
 *     LGN-001  账号密码登录       登录模块/账号密码登录组/账号密码登录
 *     LGN-002  密码错误拦截       登录模块/账号密码登录组/密码错误拦截
 *     LGN-003  账号不存在         登录模块/账号密码登录组/账号不存在
 *     LGN-004  图形验证码         登录模块/验证码相关/图形验证码
 *     LGN-005  短信验证码登录     登录模块/验证码相关/短信验证码登录
 *     LGN-008  扫码登录           登录模块/第三方登录/扫码登录
 *     (empty)  扫码登录_异常场景  登录模块/第三方登录/扫码登录/扫码登录_异常场景
 *     LGN-009  第三方登录_微信    登录模块/第三方登录/第三方登录_微信
 *     LGN-010  第三方登录_QQ      登录模块/第三方登录/第三方登录_QQ
 *     LGN-034  会话超时           登录模块/会话与Token/会话超时
 *     LGN-035  Token刷新          登录模块/会话与Token/Token刷新
 * ----------------------------------------------------------------------------
 * 用法：node scripts/build-xmind-example.js <输出路径.xmind>
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const outPath = process.argv[2];
if (!outPath) {
    console.error('用法：node scripts/build-xmind-example.js <输出路径.xmind>');
    process.exit(1);
}

// ---- topic 构造辅助 ----
function topic(title, opts = {}) {
    const t = {
        id: `id-${title}-${Math.random().toString(36).slice(2, 8)}`,
        title,
        structureClass: 'org.xmind.ui.logic.right',
    };
    if (opts.markers && opts.markers.length > 0) {
        t.markers = opts.markers.map(id => ({ markerId: id }));
    }
    if (opts.labels && opts.labels.length > 0) {
        t.labels = opts.labels.slice();
    }
    if (opts.children && opts.children.length > 0) {
        t.children = { attached: opts.children };
    }
    return t;
}

// ---- 构造中心主题树 ----
const root = topic('账户中心', {
    // 根节点豁免图标校验
    children: [
        topic('登录模块', {
            markers: ['flag-red'],
            children: [
                topic('账号密码登录组', {
                    markers: ['flag-orange'],
                    children: [
                        topic('账号密码登录', { markers: ['star-red'], labels: ['LGN-001'] }),
                        topic('密码错误拦截', { markers: ['star-red'], labels: ['LGN-002'] }),
                        topic('账号不存在', { markers: ['star-red'], labels: ['LGN-003'] }),
                    ],
                }),
                topic('验证码相关', {
                    markers: ['flag-orange'],
                    children: [
                        topic('图形验证码', {
                            markers: ['star-red'],
                            labels: ['LGN-004'],
                            children: [
                                // 说明节点：处于星形子树，忽略不校验
                                topic('场景说明：应支持刷新验证码', {}),
                            ],
                        }),
                        topic('短信验证码登录', { markers: ['star-red'], labels: ['LGN-005'] }),
                    ],
                }),
                topic('第三方登录', {
                    markers: ['flag-orange'],
                    children: [
                        topic('扫码登录', {
                            markers: ['star-red'],
                            labels: ['LGN-008'],
                            children: [
                                // 嵌套测试点：无 label → pointId 为空，走 pointPath 匹配
                                topic('扫码登录_异常场景', { markers: ['star-red'] }),
                            ],
                        }),
                        topic('第三方登录_微信', { markers: ['star-red'], labels: ['LGN-009'] }),
                        topic('第三方登录_QQ', { markers: ['star-red'], labels: ['LGN-010'] }),
                    ],
                }),
                topic('会话与Token', {
                    markers: ['flag-orange'],
                    children: [
                        topic('会话超时', { markers: ['star-red'], labels: ['LGN-034'] }),
                        topic('Token刷新', { markers: ['star-red'], labels: ['LGN-035'] }),
                    ],
                }),
            ],
        }),
    ],
});

// ---- content.json：xmind ZEN 顶层是 sheet 数组 ----
const content = [
    {
        id: 'sheet-1',
        title: '画布 1',
        rootTopic: root,
        // theme / topicOverlapping 等字段可选，不填不影响 XMind 打开与本 parser 解析
    },
];

// ---- 其他辅助元数据（可选，但加上更像官方产物，避免某些版本 XMind 打开时报警告） ----
const metadata = {
    creator: {
        name: 'workbench xmind builder',
        version: '1.0.0',
    },
    dataStructureVersion: '2',
    activeSheetId: 'sheet-1',
};

const manifest = {
    'file-entries': {
        'content.json': {},
        'metadata.json': {},
        'manifest.json': {},
    },
};

// ---- 打包 zip ----
(async () => {
    const zip = new JSZip();
    zip.file('content.json', JSON.stringify(content));
    zip.file('metadata.json', JSON.stringify(metadata));
    zip.file('manifest.json', JSON.stringify(manifest));
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
    console.log(`✅ 已生成 xmind：${outPath}（${buf.length} bytes）`);
})();
