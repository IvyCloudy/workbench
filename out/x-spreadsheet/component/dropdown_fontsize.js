"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dropdown_1 = __importDefault(require("./dropdown"));
const element_1 = require("./element");
const font_1 = require("../core/font");
const config_1 = require("../config");
class DropdownFontSize extends dropdown_1.default {
    constructor() {
        const nfontSizes = font_1.fontSizes.map(it => (0, element_1.h)('div', `${config_1.cssPrefix}-item`)
            .on('click', () => {
            this.setTitle(`${it.pt}`);
            this.change(it);
        })
            .child(`${it.pt}`));
        super('10', '60px', true, 'bottom-left', ...nfontSizes);
    }
}
exports.default = DropdownFontSize;
//# sourceMappingURL=dropdown_fontsize.js.map