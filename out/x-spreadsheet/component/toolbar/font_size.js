"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dropdown_item_1 = __importDefault(require("./dropdown_item"));
const dropdown_fontsize_1 = __importDefault(require("../dropdown_fontsize"));
class Format extends dropdown_item_1.default {
    constructor() {
        super('font-size');
    }
    getValue(it) {
        return it.pt;
    }
    dropdown() {
        return new dropdown_fontsize_1.default();
    }
}
exports.default = Format;
//# sourceMappingURL=font_size.js.map