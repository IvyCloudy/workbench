"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dropdown_1 = __importDefault(require("./dropdown"));
const icon_1 = __importDefault(require("./icon"));
const border_palette_1 = __importDefault(require("./border_palette"));
class DropdownBorder extends dropdown_1.default {
    constructor() {
        const icon = new icon_1.default('border-all');
        const borderPalette = new border_palette_1.default();
        borderPalette.change = (v) => {
            this.change(v);
            this.hide();
        };
        super(icon, 'auto', false, 'bottom-left', borderPalette.el);
    }
}
exports.default = DropdownBorder;
//# sourceMappingURL=dropdown_border.js.map