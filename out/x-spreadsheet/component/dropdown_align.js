"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dropdown_1 = __importDefault(require("./dropdown"));
const element_1 = require("./element");
const icon_1 = __importDefault(require("./icon"));
const config_1 = require("../config");
function buildItemWithIcon(iconName) {
    return (0, element_1.h)('div', `${config_1.cssPrefix}-item`).child(new icon_1.default(iconName));
}
class DropdownAlign extends dropdown_1.default {
    constructor(aligns, align) {
        const icon = new icon_1.default(`align-${align}`);
        const naligns = aligns.map(it => buildItemWithIcon(`align-${it}`)
            .on('click', () => {
            this.setTitle(it);
            this.change(it);
        }));
        super(icon, 'auto', true, 'bottom-left', ...naligns);
    }
    setTitle(align) {
        this.title.setName(`align-${align}`);
        this.hide();
    }
}
exports.default = DropdownAlign;
//# sourceMappingURL=dropdown_align.js.map