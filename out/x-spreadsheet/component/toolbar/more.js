"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dropdown_1 = __importDefault(require("../dropdown"));
const dropdown_item_1 = __importDefault(require("./dropdown_item"));
const config_1 = require("../../config");
const element_1 = require("../element");
const icon_1 = __importDefault(require("../icon"));
class DropdownMore extends dropdown_1.default {
    constructor() {
        const icon = new icon_1.default('ellipsis');
        const moreBtns = (0, element_1.h)('div', `${config_1.cssPrefix}-toolbar-more`);
        super(icon, 'auto', false, 'bottom-right', moreBtns);
        this.moreBtns = moreBtns;
        this.contentEl.css('max-width', '420px');
    }
}
class More extends dropdown_item_1.default {
    constructor() {
        super('more');
        this.el.hide();
    }
    dropdown() {
        return new DropdownMore();
    }
    show() {
        this.el.show();
    }
    hide() {
        this.el.hide();
    }
}
exports.default = More;
//# sourceMappingURL=more.js.map