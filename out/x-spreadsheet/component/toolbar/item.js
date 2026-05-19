"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("../../config");
const tooltip_1 = __importDefault(require("../tooltip"));
const element_1 = require("../element");
const locale_1 = require("../../locale/locale");
class Item {
    // tooltip
    // tag: the subclass type
    // shortcut: shortcut key
    constructor(tag, shortcut, value) {
        this.tip = '';
        if (tag)
            this.tip = (0, locale_1.t)(`toolbar.${tag.replace(/-[a-z]/g, c => c[1].toUpperCase())}`);
        if (shortcut)
            this.tip += ` (${shortcut})`;
        this.tag = tag;
        this.shortcut = shortcut;
        this.value = value;
        this.el = this.element();
        this.change = () => { };
    }
    element() {
        const { tip } = this;
        return (0, element_1.h)('div', `${config_1.cssPrefix}-toolbar-btn`)
            .on('mouseenter', (evt) => {
            if (this.tip)
                (0, tooltip_1.default)(this.tip, evt.target);
        })
            .attr('data-tooltip', tip);
    }
    setState() { }
}
exports.default = Item;
//# sourceMappingURL=item.js.map