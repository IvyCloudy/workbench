"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dropdown_item_1 = __importDefault(require("./dropdown_item"));
const dropdown_color_1 = __importDefault(require("../dropdown_color"));
class FillColor extends dropdown_item_1.default {
    constructor(color) {
        super('bgcolor', undefined, color);
    }
    dropdown() {
        const { tag, value } = this;
        return new dropdown_color_1.default(tag, value);
    }
}
exports.default = FillColor;
//# sourceMappingURL=fill_color.js.map