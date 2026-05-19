"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dropdown_1 = __importDefault(require("./dropdown"));
const icon_1 = __importDefault(require("./icon"));
const color_palette_1 = __importDefault(require("./color_palette"));
class DropdownColor extends dropdown_1.default {
    constructor(iconName, color) {
        const icon = new icon_1.default(iconName)
            .css('height', '16px')
            .css('border-bottom', `3px solid ${color}`);
        const colorPalette = new color_palette_1.default();
        colorPalette.change = (v) => {
            this.setTitle(v);
            this.change(v);
        };
        super(icon, 'auto', false, 'bottom-left', colorPalette.el);
    }
    setTitle(color) {
        this.title.css('border-color', color);
        this.hide();
    }
}
exports.default = DropdownColor;
//# sourceMappingURL=dropdown_color.js.map