"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const element_1 = require("./element");
const icon_1 = __importDefault(require("./icon"));
const dropdown_color_1 = __importDefault(require("./dropdown_color"));
const dropdown_linetype_1 = __importDefault(require("./dropdown_linetype"));
const config_1 = require("../config");
function buildTable(...trs) {
    return (0, element_1.h)('table', '').child((0, element_1.h)('tbody', '').children(...trs));
}
function buildTd(iconName) {
    return (0, element_1.h)('td', '').child((0, element_1.h)('div', `${config_1.cssPrefix}-border-palette-cell`).child(new icon_1.default(`border-${iconName}`)).on('click', () => {
        this.mode = iconName;
        const { mode, style, color } = this;
        this.change({ mode, style, color });
    }));
}
class BorderPalette {
    constructor() {
        this.color = '#000';
        this.style = 'thin';
        this.mode = 'all';
        this.change = () => { };
        this.ddColor = new dropdown_color_1.default('line-color', this.color);
        this.ddColor.change = (color) => {
            this.color = color;
        };
        this.ddType = new dropdown_linetype_1.default(this.style);
        this.ddType.change = ([s]) => {
            this.style = s;
        };
        this.el = (0, element_1.h)('div', `${config_1.cssPrefix}-border-palette`);
        const table = buildTable((0, element_1.h)('tr', '').children((0, element_1.h)('td', `${config_1.cssPrefix}-border-palette-left`).child(buildTable((0, element_1.h)('tr', '').children(...['all', 'inside', 'horizontal', 'vertical', 'outside'].map(it => buildTd.call(this, it))), (0, element_1.h)('tr', '').children(...['left', 'top', 'right', 'bottom', 'none'].map(it => buildTd.call(this, it))))), (0, element_1.h)('td', `${config_1.cssPrefix}-border-palette-right`).children((0, element_1.h)('div', `${config_1.cssPrefix}-toolbar-btn`).child(this.ddColor.el), (0, element_1.h)('div', `${config_1.cssPrefix}-toolbar-btn`).child(this.ddType.el))));
        this.el.child(table);
    }
}
exports.default = BorderPalette;
//# sourceMappingURL=border_palette.js.map