"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dropdown_1 = __importDefault(require("./dropdown"));
const element_1 = require("./element");
const font_1 = require("../core/font");
const config_1 = require("../config");
class DropdownFont extends dropdown_1.default {
    constructor() {
        const nfonts = font_1.baseFonts.map(it => (0, element_1.h)('div', `${config_1.cssPrefix}-item`)
            .on('click', () => {
            this.setTitle(it.title);
            this.change(it);
        })
            .child(it.title));
        super(font_1.baseFonts[0].title, '160px', true, 'bottom-left', ...nfonts);
    }
}
exports.default = DropdownFont;
//# sourceMappingURL=dropdown_font.js.map