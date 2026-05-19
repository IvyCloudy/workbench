"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dropdown_1 = __importDefault(require("./dropdown"));
const element_1 = require("./element");
const format_1 = require("../core/format");
const config_1 = require("../config");
class DropdownFormat extends dropdown_1.default {
    constructor() {
        let nformats = format_1.baseFormats.slice(0);
        nformats.splice(2, 0, { key: 'divider' });
        nformats.splice(8, 0, { key: 'divider' });
        nformats = nformats.map((it) => {
            const item = (0, element_1.h)('div', `${config_1.cssPrefix}-item`);
            if (it.key === 'divider') {
                item.addClass('divider');
            }
            else {
                item.child(it.title())
                    .on('click', () => {
                    this.setTitle(it.title());
                    this.change(it);
                });
                if (it.label)
                    item.child((0, element_1.h)('div', 'label').html(it.label));
            }
            return item;
        });
        super('Normal', '220px', true, 'bottom-left', ...nformats);
    }
    setTitle(key) {
        for (let i = 0; i < format_1.baseFormats.length; i += 1) {
            if (format_1.baseFormats[i].key === key) {
                this.title.html(format_1.baseFormats[i].title());
            }
        }
        this.hide();
    }
}
exports.default = DropdownFormat;
//# sourceMappingURL=dropdown_format.js.map