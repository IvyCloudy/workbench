// ============================================================================
// 思维导图图标库（彩色 SVG 徽章版）
// - 完全对照 ProcessOn 风格图标面板：Priority / Progress / Emotion / Arrow /
//   Flag / Star / Date(Month/Week) / Symbol
// - 每个图标分配一个稳定 token：`<type>_<name>`（如 priority_1、progress_3、
//   flag_red、month_jan、sym_check ...），与 simple-mind-map 内置 icon key 同
//   构，因此可以通过 `iconList` 选项直接注册到节点渲染管线，由 vendor 自身把
//   SVG 字符串渲染到节点上，**完全无需修改 vendor**。
// - token 同时用作 .md 序列化的图标占位符，可读、可跨平台还原。
// ============================================================================

// ---------- SVG 生成器 ----------
const SIZE = 24; // 视觉基准尺寸（vendor 会按 themeConfig.iconSize 缩放）

// 圆形彩色徽章 + 文字（用于 Priority、Date Month/Week 等）
function badgeText(bg, text, opt = {}) {
    const fg = opt.fg || '#FFFFFF';
    const fontSize = opt.fontSize || 12;
    const fontWeight = opt.fontWeight || 700;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">`
        + `<circle cx="12" cy="12" r="11" fill="${bg}"/>`
        + `<text x="12" y="12" text-anchor="middle" dominant-baseline="central" `
        + `font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" `
        + `font-size="${fontSize}" font-weight="${fontWeight}" fill="${fg}">${text}</text>`
        + `</svg>`;
}

// 圆形彩色徽章 + 任意 inner SVG（用于 Symbol/Arrow/Star/Flag 等）
function badgeInner(bg, inner, opt = {}) {
    const stroke = opt.stroke || 'none';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">`
        + `<circle cx="12" cy="12" r="11" fill="${bg}" stroke="${stroke}"/>`
        + inner
        + `</svg>`;
}

// 进度饼图：根据百分比生成（0 / 12.5 / 25 / 37.5 / 50 / 75 / 87.5 / 100 / done）
// 颜色随进度由"橙红"→"黄绿"→"翠绿"分段切换，与 ProcessOn Progress 图组风格一致。
function progressPie(percent) {
    // 'done' 走完成态（绿色填充圆 + 白对勾）
    if (percent === 'done') {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">`
            + `<circle cx="12" cy="12" r="11" fill="#2DBE60"/>`
            + `<path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`
            + `</svg>`;
    }
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    // 颜色分段：0 红、(0,50) 橙、=50 黄绿、>50 绿、100 深绿
    let color;
    if (p === 0) color = '#FF5C5C';
    else if (p < 50) color = '#FF8A3D';
    else if (p === 50) color = '#9DD64A';
    else if (p < 100) color = '#3FBE5C';
    else color = '#2DBE60';

    // 空心圆（0%）
    if (p === 0) {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">`
            + `<circle cx="12" cy="12" r="9" fill="#FFFFFF" stroke="${color}" stroke-width="2"/>`
            + `</svg>`;
    }
    // 整圆（100%）
    if (p === 100) {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">`
            + `<circle cx="12" cy="12" r="9" fill="${color}" stroke="${color}" stroke-width="2"/>`
            + `</svg>`;
    }
    // 中间百分比：描边 + 同色扇形（从 12 点钟方向顺时针）
    const sweepAngle = (p / 100) * 360;
    const rad = (deg) => (deg - 90) * Math.PI / 180;
    const r = 9, cx = 12, cy = 12;
    const ex = cx + r * Math.cos(rad(sweepAngle));
    const ey = cy + r * Math.sin(rad(sweepAngle));
    const largeArc = sweepAngle > 180 ? 1 : 0;
    const d = `M${cx},${cy} L${cx},${cy - r} A${r},${r} 0 ${largeArc},1 ${ex},${ey} Z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">`
        + `<circle cx="12" cy="12" r="9" fill="#FFFFFF" stroke="${color}" stroke-width="2"/>`
        + `<path d="${d}" fill="${color}"/>`
        + `</svg>`;
}

// 单色色板
const COLORS = {
    red: '#FF5C5C', orange: '#FF8A3D', yellow: '#FFC53D', green: '#2DBE60',
    teal: '#1FB6A8', blue: '#3D8BFF', indigo: '#5B6BFF', purple: '#A05BFF',
    pink: '#F25CB0', gray: '#9AA0A6', brown: '#A06A3D', dark: '#3A4054',
};

// ---------- 1. Priority（1..16） ----------
// 颜色循环：1红 2橙 3黄 4绿 5青 6蓝 7深蓝 8紫 ；9..16 灰色（图示一致）
const priorityColors = [
    COLORS.red, COLORS.orange, COLORS.yellow, COLORS.green,
    COLORS.teal, COLORS.blue, COLORS.indigo, COLORS.purple,
    COLORS.gray, COLORS.gray, COLORS.gray, COLORS.gray,
    COLORS.gray, COLORS.gray, COLORS.gray, COLORS.gray,
];
const priorityList = priorityColors.map((bg, i) => ({
    name: String(i + 1),
    icon: badgeText(bg, String(i + 1), { fontSize: i + 1 >= 10 ? 10 : 12 }),
}));

// ---------- 2. Progress ----------
// 8 段进度图标（与 ProcessOn 设计一致）：0 / 12.5 / 25 / 37.5 / 50 / 75 / 87.5 / 100
// name 保留为整数百分比字符串，'done' 表示完成对勾。
const progressList = [
    { name: '0',    icon: progressPie(0) },
    { name: '13',   icon: progressPie(12.5) },
    { name: '25',   icon: progressPie(25) },
    { name: '38',   icon: progressPie(37.5) },
    { name: '50',   icon: progressPie(50) },
    { name: '75',   icon: progressPie(75) },
    { name: '88',   icon: progressPie(87.5) },
    { name: 'done', icon: progressPie('done') },
];

// ---------- 3. Emotion（彩色表情，纯 SVG） ----------
// 直接画卡通脸：黄底圆 + 不同表情五官
function emotionFace(kind) {
    // kind: smile / grin / laugh / haha / kiss / love / cool / wink / cry / angry / sleepy / surprised / nerd / sick / devil / shy
    const base = `<circle cx="12" cy="12" r="11" fill="#FFD93D"/>`;
    let extra = '';
    // 眼睛默认两个黑点
    let eyes = `<circle cx="9" cy="10" r="1.1" fill="#3A2E1A"/><circle cx="15" cy="10" r="1.1" fill="#3A2E1A"/>`;
    // 嘴默认微笑
    let mouth = `<path d="M8.5 14.5c1 1.4 2.2 2 3.5 2s2.5-.6 3.5-2" fill="none" stroke="#3A2E1A" stroke-width="1.4" stroke-linecap="round"/>`;
    switch (kind) {
        case 'smile':
            break;
        case 'grin':
            mouth = `<path d="M7.5 13.5c1.5 2.2 3 3 4.5 3s3-.8 4.5-3z" fill="#FFFFFF" stroke="#3A2E1A" stroke-width="1.2" stroke-linejoin="round"/>`;
            break;
        case 'laugh':
            eyes = `<path d="M7.5 10.5c.5-.6 1-.6 1.5 0M14 10.5c.5-.6 1-.6 1.5 0" fill="none" stroke="#3A2E1A" stroke-width="1.4" stroke-linecap="round"/>`;
            mouth = `<path d="M7 13.5c1.5 2.4 3.2 3.4 5 3.4s3.5-1 5-3.4z" fill="#3A2E1A"/><path d="M9 16h6" stroke="#FFFFFF" stroke-width="1" stroke-linecap="round"/>`;
            break;
        case 'haha':
            eyes = `<path d="M7.5 10.5c.5-.6 1-.6 1.5 0M14 10.5c.5-.6 1-.6 1.5 0" fill="none" stroke="#3A2E1A" stroke-width="1.4" stroke-linecap="round"/>`;
            mouth = `<path d="M7 13.5c1.5 2.4 3.2 3.4 5 3.4s3.5-1 5-3.4z" fill="#3A2E1A"/><path d="M5 11l-1.5-.5M19 11l1.5-.5" stroke="#3D8BFF" stroke-width="1" stroke-linecap="round"/>`;
            break;
        case 'kiss':
            eyes = `<path d="M7.5 10.5c.5-.6 1-.6 1.5 0M14 10.5c.5-.6 1-.6 1.5 0" fill="none" stroke="#3A2E1A" stroke-width="1.4" stroke-linecap="round"/>`;
            mouth = `<ellipse cx="12" cy="15.5" rx="1.4" ry="1" fill="#FF5C5C"/>`;
            break;
        case 'love':
            eyes = `<path d="M7 10c0-1 1.4-1.6 2-.4.6-1.2 2-.6 2 .4 0 1.2-2 2.4-2 2.4S7 11.2 7 10zM13 10c0-1 1.4-1.6 2-.4.6-1.2 2-.6 2 .4 0 1.2-2 2.4-2 2.4S13 11.2 13 10z" fill="#FF5C5C"/>`;
            break;
        case 'cool':
            eyes = `<rect x="6" y="9" width="12" height="2.4" rx="0.6" fill="#3A4054"/><rect x="6.6" y="9.4" width="4.4" height="1.6" rx="0.4" fill="#000"/><rect x="13" y="9.4" width="4.4" height="1.6" rx="0.4" fill="#000"/>`;
            break;
        case 'wink':
            eyes = `<circle cx="9" cy="10" r="1.1" fill="#3A2E1A"/><path d="M14 10.5c.5-.6 1-.6 1.5 0" fill="none" stroke="#3A2E1A" stroke-width="1.4" stroke-linecap="round"/>`;
            break;
        case 'cry':
            eyes = `<path d="M7.5 10.5c.5-.6 1-.6 1.5 0M14 10.5c.5-.6 1-.6 1.5 0" fill="none" stroke="#3A2E1A" stroke-width="1.4" stroke-linecap="round"/>`;
            mouth = `<path d="M9.5 16c1-1.5 4-1.5 5 0" fill="none" stroke="#3A2E1A" stroke-width="1.4" stroke-linecap="round"/><path d="M8 12c-.5 2.5-1.5 4 0 5M16 12c.5 2.5 1.5 4 0 5" fill="#5BD0FF" stroke="#3D8BFF" stroke-width="0.6"/>`;
            break;
        case 'angry':
            extra = '';
            eyes = `<path d="M7 9l2 1M17 9l-2 1" stroke="#3A2E1A" stroke-width="1.4" stroke-linecap="round"/><circle cx="9" cy="11" r="0.9" fill="#3A2E1A"/><circle cx="15" cy="11" r="0.9" fill="#3A2E1A"/>`;
            mouth = `<path d="M9.5 16c1-1.5 4-1.5 5 0" fill="none" stroke="#3A2E1A" stroke-width="1.4" stroke-linecap="round"/>`;
            break;
        case 'sleepy':
            eyes = `<path d="M7 10h3M14 10h3" stroke="#3A2E1A" stroke-width="1.4" stroke-linecap="round"/>`;
            mouth = `<path d="M10 15c.6-.4 1.4-.4 2 0" fill="none" stroke="#3A2E1A" stroke-width="1.4" stroke-linecap="round"/>`;
            break;
        case 'surprised':
            mouth = `<circle cx="12" cy="15.2" r="1.6" fill="#3A2E1A"/>`;
            break;
        case 'nerd':
            eyes = `<rect x="6" y="8.6" width="5" height="3" rx="1.2" fill="none" stroke="#3A4054" stroke-width="1"/>` +
                `<rect x="13" y="8.6" width="5" height="3" rx="1.2" fill="none" stroke="#3A4054" stroke-width="1"/>` +
                `<line x1="11" y1="10" x2="13" y2="10" stroke="#3A4054" stroke-width="1"/>` +
                `<circle cx="8.5" cy="10.1" r="0.7" fill="#3A2E1A"/>` +
                `<circle cx="15.5" cy="10.1" r="0.7" fill="#3A2E1A"/>`;
            break;
        case 'sick':
            mouth = `<path d="M9 15.5c.6-1 1.4 1 2 0s1.4 1 2 0 1.4 1 2 0" fill="none" stroke="#3A2E1A" stroke-width="1.4" stroke-linecap="round"/>`;
            extra = `<rect x="14" y="5" width="6" height="3" rx="0.6" fill="#67D58D"/>`;
            break;
        case 'devil':
            // 红色基底
            return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">`
                + `<path d="M5 7l2-3 2 3M15 7l2-3 2 3" fill="#B12C2C"/>`
                + `<circle cx="12" cy="13" r="9" fill="#E04040"/>`
                + `<path d="M8 11l2 1M16 11l-2 1" stroke="#3A0E0E" stroke-width="1.4" stroke-linecap="round"/>`
                + `<circle cx="9.5" cy="12.4" r="0.9" fill="#3A0E0E"/>`
                + `<circle cx="14.5" cy="12.4" r="0.9" fill="#3A0E0E"/>`
                + `<path d="M9 17c1-1.5 4-1.5 5 0" fill="none" stroke="#3A0E0E" stroke-width="1.4" stroke-linecap="round"/>`
                + `</svg>`;
        case 'shy':
            extra = `<circle cx="6" cy="14" r="1.6" fill="#FF9EAA" opacity="0.7"/><circle cx="18" cy="14" r="1.6" fill="#FF9EAA" opacity="0.7"/>`;
            mouth = `<path d="M10 15c.6-.4 1.4-.4 2 0" fill="none" stroke="#3A2E1A" stroke-width="1.4" stroke-linecap="round"/>`;
            break;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">${base}${extra}${eyes}${mouth}</svg>`;
}
const emotionList = [
    'smile','grin','laugh','haha','kiss','love','cool','wink',
    'cry','angry','sleepy','surprised','nerd','sick','devil','shy',
].map(k => ({ name: k, icon: emotionFace(k) }));

// ---------- 4. Arrow（橙色徽章 + 白色箭头） ----------
function arrow(dir) {
    // dir: up,right,down,left,leftRight,upDown,refresh,sync
    const inner = (() => {
        switch (dir) {
            case 'up':        return `<path d="M12 6.5l4 4M12 6.5l-4 4M12 6.5v11" stroke="#FFFFFF" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
            case 'right':     return `<path d="M17.5 12l-4-4M17.5 12l-4 4M17.5 12h-11" stroke="#FFFFFF" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
            case 'down':      return `<path d="M12 17.5l4-4M12 17.5l-4-4M12 17.5v-11" stroke="#FFFFFF" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
            case 'left':      return `<path d="M6.5 12l4-4M6.5 12l4 4M6.5 12h11" stroke="#FFFFFF" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
            case 'leftRight': return `<path d="M6.5 12h11M6.5 12l3-3M6.5 12l3 3M17.5 12l-3-3M17.5 12l-3 3" stroke="#FFFFFF" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
            case 'upDown':    return `<path d="M12 6.5v11M12 6.5l-3 3M12 6.5l3 3M12 17.5l-3-3M12 17.5l3-3" stroke="#FFFFFF" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
            case 'refresh':   return `<path d="M16 8a5 5 0 1 0 1.5 4" stroke="#FFFFFF" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M16 6v3h-3" stroke="#FFFFFF" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
            case 'sync':      return `<path d="M7 10a5 5 0 0 1 8.5-2.5M17 14a5 5 0 0 1-8.5 2.5" stroke="#FFFFFF" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M14.5 7l1 .5.5-1.5M9.5 17l-1-.5-.5 1.5" stroke="#FFFFFF" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
        }
        return '';
    })();
    return badgeInner('#FF8A3D', inner);
}
const arrowList = [
    'up','right','down','left','leftRight','upDown','refresh','sync',
].map(k => ({ name: k, icon: arrow(k) }));

// ---------- 5. Flag（小旗，多色） ----------
function flag(color) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">`
        + `<path d="M7 4v16" stroke="#3A4054" stroke-width="1.6" stroke-linecap="round"/>`
        + `<path d="M7 5h10l-2.2 3.5L17 12H7z" fill="${color}"/>`
        + `</svg>`;
}
const flagColors = [
    { name: 'red', color: COLORS.red },
    { name: 'orange', color: COLORS.orange },
    { name: 'yellow', color: COLORS.yellow },
    { name: 'green', color: COLORS.green },
    { name: 'blue', color: COLORS.blue },
    { name: 'purple', color: COLORS.purple },
    { name: 'pink', color: COLORS.pink },
    { name: 'gray', color: COLORS.gray },
];
const flagList = flagColors.map(({ name, color }) => ({ name, icon: flag(color) }));

// ---------- 6. Star（圆形彩色徽章 + 白星） ----------
function starBadge(bg) {
    const star = `<path d="M12 5l2.2 4.5 5 .6-3.7 3.4 1 5-4.5-2.5-4.5 2.5 1-5L4.8 10.1l5-.6z" fill="#FFFFFF"/>`;
    return badgeInner(bg, star);
}
const starColors = [
    { name: 'red', color: COLORS.red },
    { name: 'orange', color: COLORS.orange },
    { name: 'green', color: COLORS.green },
    { name: 'blue', color: COLORS.blue },
    { name: 'purple', color: COLORS.purple },
    { name: 'pink', color: COLORS.pink },
    { name: 'gray', color: COLORS.gray },
];
const starList = starColors.map(({ name, color }) => ({ name, icon: starBadge(color) }));

// ---------- 7. Date · Month / Week（蓝色徽章 + 文字） ----------
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const monthList = months.map(m => ({
    name: m.toLowerCase(),
    icon: badgeText('#3D8BFF', m, { fontSize: 8.5, fontWeight: 700 }),
}));
const weekDays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const weekList = weekDays.map(w => ({
    name: w.toLowerCase(),
    icon: badgeText('#9AA0A6', w, { fontSize: 8.5, fontWeight: 700 }),
}));

// ---------- 8. Symbol（others 杂项）— 与图片一一对应 ----------
function sym(bg, inner) { return badgeInner(bg, inner); }
const symbolList = [
    { name: 'check',    icon: sym('#2DBE60', `<path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`) },
    { name: 'cross',    icon: sym('#FF5C5C', `<path d="M8 8l8 8M16 8l-8 8" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round"/>`) },
    { name: 'note',     icon: sym('#3D8BFF', `<rect x="7" y="6.5" width="10" height="11" rx="1.4" fill="#FFFFFF"/><path d="M9 10h6M9 12.5h6M9 15h4" stroke="#3D8BFF" stroke-width="1.2" stroke-linecap="round"/>`) },
    { name: 'time',     icon: sym('#3A4054', `<circle cx="12" cy="12" r="6.5" fill="none" stroke="#FFFFFF" stroke-width="1.6"/><path d="M12 8.5v4l2.5 1.5" stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round"/>`) },
    { name: 'warn',     icon: sym('#FF8A3D', `<path d="M12 6l6.5 11h-13z" fill="#FFFFFF"/><path d="M12 10v3.4M12 15.4v.8" stroke="#FF8A3D" stroke-width="1.6" stroke-linecap="round"/>`) },
    { name: 'info',     icon: sym('#3D8BFF', `<path d="M12 9v0M12 11.5v5.5" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/>`) },
    { name: 'question', icon: sym('#A05BFF', `<path d="M9 10c0-2 1.5-3 3-3s3 1 3 2.6c0 1.4-1 2-2 2.6-.8.4-1 .8-1 1.6M12 17v.6" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round" fill="none"/>`) },
    { name: 'idea',     icon: sym('#FFC53D', `<path d="M9 10a3 3 0 0 1 6 0c0 1.4-1 2.4-1.5 3.4-.3.6-.5 1.4-.5 2h-2c0-.6-.2-1.4-.5-2C10 12.4 9 11.4 9 10z" fill="#FFFFFF"/><path d="M10 17h4M10.5 19h3" stroke="#FFFFFF" stroke-width="1.4" stroke-linecap="round"/>`) },
    { name: 'pie',      icon: sym('#A05BFF', `<path d="M12 6v6h6a6 6 0 1 1-6-6z" fill="#FFFFFF"/><path d="M13 6.2a5.5 5.5 0 0 1 4.8 4.8H13z" fill="#FFD33D"/>`) },
    { name: 'gift',     icon: sym('#A05BFF', `<rect x="6" y="11" width="12" height="6.5" rx="0.6" fill="#FFFFFF"/><rect x="5.5" y="9" width="13" height="2.5" rx="0.6" fill="#FFFFFF"/><path d="M12 9v8.5" stroke="#A05BFF" stroke-width="1.4"/><path d="M9 9c-1.5-2 1-3 3-1 2-2 4.5-1 3 1z" fill="#FFFFFF"/>`) },
    { name: 'lock',     icon: sym('#3A4054', `<rect x="7.5" y="11" width="9" height="6.5" rx="0.8" fill="#FFFFFF"/><path d="M9 11V9a3 3 0 0 1 6 0v2" stroke="#FFFFFF" stroke-width="1.6" fill="none"/>`) },
    { name: 'unlock',   icon: sym('#5B6BFF', `<rect x="7.5" y="11" width="9" height="6.5" rx="0.8" fill="#FFFFFF"/><path d="M9 11V9a3 3 0 0 1 5.5-1.6" stroke="#FFFFFF" stroke-width="1.6" fill="none"/>`) },
    { name: 'mail',     icon: sym('#3D8BFF', `<rect x="6" y="8" width="12" height="8" rx="1" fill="#FFFFFF"/><path d="M6.5 8.5L12 13l5.5-4.5" stroke="#3D8BFF" stroke-width="1.4" fill="none"/>`) },
    { name: 'cloud',    icon: sym('#3D8BFF', `<path d="M8 15h9a3 3 0 0 0 0-6 4 4 0 0 0-7.7-1A2.8 2.8 0 0 0 8 15z" fill="#FFFFFF"/>`) },
    { name: 'gear',     icon: sym('#3D8BFF', `<path d="M12 7.5l1 1.6 1.8-.4.4 1.8 1.6 1-1 1.6 1 1.6-1.6 1-.4 1.8-1.8-.4-1 1.6-1-1.6-1.8.4-.4-1.8-1.6-1 1-1.6-1-1.6 1.6-1 .4-1.8 1.8.4z" fill="#FFFFFF"/><circle cx="12" cy="12" r="1.8" fill="#3D8BFF"/>`) },
    { name: 'bulb',     icon: sym('#FFC53D', `<path d="M9 10a3 3 0 0 1 6 0c0 1.4-1 2.4-1.5 3.4-.3.6-.5 1.4-.5 2h-2c0-.6-.2-1.4-.5-2C10 12.4 9 11.4 9 10z" fill="#FFFFFF"/><path d="M10 16h4M10.5 18h3" stroke="#FFFFFF" stroke-width="1.4" stroke-linecap="round"/>`) },
    { name: 'book',     icon: sym('#5B6BFF', `<path d="M6 7.5h5.5v10H7a1 1 0 0 1-1-1V7.5zM18 7.5h-5.5v10H17a1 1 0 0 0 1-1V7.5z" fill="#FFFFFF"/>`) },
    { name: 'doc',      icon: sym('#A05BFF', `<path d="M8 6.5h6l3 3v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" fill="#FFFFFF"/><path d="M14 6.5v3h3" stroke="#A05BFF" stroke-width="1.2" fill="none"/>`) },
    { name: 'thumbup',  icon: sym('#3D8BFF', `<path d="M9 12v5.2h5.5a1.5 1.5 0 0 0 1.5-1l1-3.6a1 1 0 0 0-1-1.4h-3l.4-2.4a1 1 0 0 0-1.6-1L9 12z" fill="#FFFFFF"/><rect x="6" y="12" width="2.4" height="5.2" rx="0.4" fill="#FFFFFF"/>`) },
    { name: 'thumbdn',  icon: sym('#FF5C5C', `<path d="M9 12V6.8h5.5a1.5 1.5 0 0 1 1.5 1l1 3.6a1 1 0 0 1-1 1.4h-3l.4 2.4a1 1 0 0 1-1.6 1L9 12z" fill="#FFFFFF"/><rect x="6" y="6.8" width="2.4" height="5.2" rx="0.4" fill="#FFFFFF"/>`) },
    { name: 'comment',  icon: sym('#5B6BFF', `<path d="M6 9a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-4l-3 2.4V16H8a2 2 0 0 1-2-2z" fill="#FFFFFF"/>`) },
    { name: 'heart',    icon: sym('#F25CB0', `<path d="M12 17.5s-5-3.2-5-7a3 3 0 0 1 5-2 3 3 0 0 1 5 2c0 3.8-5 7-5 7z" fill="#FFFFFF"/>`) },
    { name: 'leaf',     icon: sym('#2DBE60', `<path d="M7 17c4-1 8-3 10-9-1 0-3 .2-5 1.4-2.4 1.4-3.6 3.4-3.6 5.6L7 17z" fill="#FFFFFF"/><path d="M7 17c2-3 5-5 9-7" stroke="#2DBE60" stroke-width="1" fill="none"/>`) },
    { name: 'user',     icon: sym('#5B6BFF', `<circle cx="12" cy="10" r="2.6" fill="#FFFFFF"/><path d="M6.5 18c.5-2.4 2.8-4 5.5-4s5 1.6 5.5 4z" fill="#FFFFFF"/>`) },
    { name: 'pen',      icon: sym('#3D8BFF', `<path d="M7 17l1.5-3 6.5-6.5 1.5 1.5L9.5 15.5z" fill="#FFFFFF"/><path d="M14 7.5l1.5-1.5 1.5 1.5-1.5 1.5z" fill="#FFFFFF"/>`) },
    { name: 'clip',     icon: sym('#9AA0A6', `<path d="M9 8.5v6a3 3 0 0 0 6 0v-7a2 2 0 0 0-4 0v7a1 1 0 0 0 2 0v-6" stroke="#FFFFFF" stroke-width="1.6" fill="none" stroke-linecap="round"/>`) },
    { name: 'flash',    icon: sym('#2DBE60', `<path d="M13 5l-5 8h4l-1 6 5-8h-4z" fill="#FFFFFF"/>`) },
    { name: 'wave',     icon: sym('#FF8A3D', `<path d="M6 13c2-3 4-3 6 0s4 3 6 0" stroke="#FFFFFF" stroke-width="2" fill="none" stroke-linecap="round"/>`) },
];

// ============================================================================
// 导出：（1）面板分组结构；（2）注册到 simple-mind-map 的 iconList
// ============================================================================

// 面板：每组保留 type/name 及 SVG 字符串（面板渲染用）；顺序与图片一致
export const ICON_GROUPS = [
    { name: 'Priority', type: 'priority', keywords: 'priority 优先级 数字',  list: priorityList },
    { name: 'Progress', type: 'progress', keywords: 'progress 进度 完成度',  list: progressList },
    { name: 'Emotion',  type: 'emotion',  keywords: 'emotion 表情 face',     list: emotionList },
    { name: 'Arrow',    type: 'arrow',    keywords: 'arrow 箭头 direction',  list: arrowList },
    { name: 'Flag',     type: 'flag',     keywords: 'flag 旗 标记',           list: flagList },
    { name: 'Star',     type: 'star',     keywords: 'star 星 收藏',           list: starList },
    {
        name: 'Date',   type: 'date',     keywords: 'date 日期 month week 月份 星期',
        sub: [
            { name: 'Month', type: 'month', list: monthList },
            { name: 'Week',  type: 'week',  list: weekList },
        ],
    },
    { name: 'Symbol (Others)', type: 'symbol', keywords: 'symbol others 其它 杂项', list: symbolList },
];

// simple-mind-map 的 iconList 选项格式：[{ name, type, list:[{ name, icon }] }]
// 同一个 type 下 name 必须唯一；token = `${type}_${name}`
// progress 类型额外追加旧 token 兼容项（progress_100 → 完成态对勾），
// 这样历史 .md 中的 progress_100 仍可渲染，且不影响新面板的 8 段进度展示。
const progressIconListForVendor = [
    ...progressList,
    { name: '100', icon: progressPie('done') },
];
export const SMM_ICON_LIST = [
    { name: '优先级', type: 'priority', list: priorityList },
    { name: '进度',   type: 'progress', list: progressIconListForVendor },
    { name: '表情',   type: 'emotion',  list: emotionList },
    { name: '箭头',   type: 'arrow',    list: arrowList },
    { name: '旗帜',   type: 'flag',     list: flagList },
    { name: '星',     type: 'star',     list: starList },
    { name: '月份',   type: 'month',    list: monthList },
    { name: '星期',   type: 'week',     list: weekList },
    { name: '符号',   type: 'symbol',   list: symbolList },
];

// 工具：判断字符串是否是我们注册的 token（type_name）
const TYPE_SET = new Set(SMM_ICON_LIST.map(g => g.type));
export function isIconToken(s) {
    if (typeof s !== 'string') return false;
    const idx = s.indexOf('_');
    if (idx <= 0) return false;
    return TYPE_SET.has(s.slice(0, idx));
}
