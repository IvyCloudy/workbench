"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.baseFormulas = exports.formulas = exports.formulam = void 0;
/**
  formula:
    key
    title
    render
*/
/**
 * @typedef {object} Formula
 * @property {string} key
 * @property {function} title
 * @property {function} render
 */
const locale_1 = require("../locale/locale");
const helper_1 = require("./helper");
/** @type {Formula[]} */
const baseFormulas = [
    {
        key: 'SUM',
        title: (0, locale_1.tf)('formula.sum'),
        render: ary => ary.reduce((a, b) => (0, helper_1.numberCalc)('+', a, b), 0),
    },
    {
        key: 'AVERAGE',
        title: (0, locale_1.tf)('formula.average'),
        render: ary => ary.reduce((a, b) => Number(a) + Number(b), 0) / ary.length,
    },
    {
        key: 'MAX',
        title: (0, locale_1.tf)('formula.max'),
        render: ary => Math.max(...ary.map(v => Number(v))),
    },
    {
        key: 'MIN',
        title: (0, locale_1.tf)('formula.min'),
        render: ary => Math.min(...ary.map(v => Number(v))),
    },
    {
        key: 'IF',
        title: (0, locale_1.tf)('formula._if'),
        render: ([b, t, f]) => (b ? t : f),
    },
    {
        key: 'AND',
        title: (0, locale_1.tf)('formula.and'),
        render: ary => ary.every(it => it),
    },
    {
        key: 'OR',
        title: (0, locale_1.tf)('formula.or'),
        render: ary => ary.some(it => it),
    },
    {
        key: 'CONCAT',
        title: (0, locale_1.tf)('formula.concat'),
        render: ary => ary.join(''),
    },
    /* support:  1 + A1 + B2 * 3
    {
      key: 'DIVIDE',
      title: tf('formula.divide'),
      render: ary => ary.reduce((a, b) => Number(a) / Number(b)),
    },
    {
      key: 'PRODUCT',
      title: tf('formula.product'),
      render: ary => ary.reduce((a, b) => Number(a) * Number(b),1),
    },
    {
      key: 'SUBTRACT',
      title: tf('formula.subtract'),
      render: ary => ary.reduce((a, b) => Number(a) - Number(b)),
    },
    */
];
exports.baseFormulas = baseFormulas;
const formulas = baseFormulas;
exports.formulas = formulas;
// const formulas = (formulaAry = []) => {
//   const formulaMap = {};
//   baseFormulas.concat(formulaAry).forEach((f) => {
//     formulaMap[f.key] = f;
//   });
//   return formulaMap;
// };
const formulam = {};
exports.formulam = formulam;
baseFormulas.forEach((f) => {
    formulam[f.key] = f;
});
exports.default = {};
//# sourceMappingURL=formula.js.map