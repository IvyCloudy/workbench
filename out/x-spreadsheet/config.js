"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dpr = exports.cssPrefix = void 0;
/* global window */
exports.cssPrefix = 'x-spreadsheet';
exports.dpr = window.devicePixelRatio || 1;
exports.default = {
    cssPrefix: exports.cssPrefix,
    dpr: exports.dpr,
};
//# sourceMappingURL=config.js.map