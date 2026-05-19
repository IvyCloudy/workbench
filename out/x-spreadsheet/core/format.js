"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.baseFormats = exports.formatm = void 0;
const locale_1 = require("../locale/locale");
const formatStringRender = v => v;
const formatNumberRender = (v) => {
    // match "-12.1" or "12" or "12.1"
    if (/^(-?\d*.?\d*)$/.test(v)) {
        const v1 = Number(v).toFixed(2).toString();
        const [first, ...parts] = v1.split('\\.');
        return [first.replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1,'), ...parts];
    }
    return v;
};
const baseFormats = [
    {
        key: 'normal',
        title: (0, locale_1.tf)('format.normal'),
        type: 'string',
        render: formatStringRender,
    },
    {
        key: 'text',
        title: (0, locale_1.tf)('format.text'),
        type: 'string',
        render: formatStringRender,
    },
    {
        key: 'number',
        title: (0, locale_1.tf)('format.number'),
        type: 'number',
        label: '1,000.12',
        render: formatNumberRender,
    },
    {
        key: 'percent',
        title: (0, locale_1.tf)('format.percent'),
        type: 'number',
        label: '10.12%',
        render: v => `${v}%`,
    },
    {
        key: 'rmb',
        title: (0, locale_1.tf)('format.rmb'),
        type: 'number',
        label: '￥10.00',
        render: v => `￥${formatNumberRender(v)}`,
    },
    {
        key: 'usd',
        title: (0, locale_1.tf)('format.usd'),
        type: 'number',
        label: '$10.00',
        render: v => `$${formatNumberRender(v)}`,
    },
    {
        key: 'eur',
        title: (0, locale_1.tf)('format.eur'),
        type: 'number',
        label: '€10.00',
        render: v => `€${formatNumberRender(v)}`,
    },
    {
        key: 'date',
        title: (0, locale_1.tf)('format.date'),
        type: 'date',
        label: '26/09/2008',
        render: formatStringRender,
    },
    {
        key: 'time',
        title: (0, locale_1.tf)('format.time'),
        type: 'date',
        label: '15:59:00',
        render: formatStringRender,
    },
    {
        key: 'datetime',
        title: (0, locale_1.tf)('format.datetime'),
        type: 'date',
        label: '26/09/2008 15:59:00',
        render: formatStringRender,
    },
    {
        key: 'duration',
        title: (0, locale_1.tf)('format.duration'),
        type: 'date',
        label: '24:01:00',
        render: formatStringRender,
    },
];
exports.baseFormats = baseFormats;
// const formats = (ary = []) => {
//   const map = {};
//   baseFormats.concat(ary).forEach((f) => {
//     map[f.key] = f;
//   });
//   return map;
// };
const formatm = {};
exports.formatm = formatm;
baseFormats.forEach((f) => {
    formatm[f.key] = f;
});
exports.default = {};
//# sourceMappingURL=format.js.map