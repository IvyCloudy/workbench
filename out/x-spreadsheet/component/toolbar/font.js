"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dropdown_item_1 = __importDefault(require("./dropdown_item"));
const dropdown_font_1 = __importDefault(require("../dropdown_font"));
class Font extends dropdown_item_1.default {
    constructor() {
        super('font-name');
    }
    getValue(it) {
        return it.key;
    }
    dropdown() {
        return new dropdown_font_1.default();
    }
}
exports.default = Font;
//# sourceMappingURL=font.js.map