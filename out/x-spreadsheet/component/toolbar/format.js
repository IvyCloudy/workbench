"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dropdown_item_1 = __importDefault(require("./dropdown_item"));
const dropdown_format_1 = __importDefault(require("../dropdown_format"));
class Format extends dropdown_item_1.default {
    constructor() {
        super('format');
    }
    getValue(it) {
        return it.key;
    }
    dropdown() {
        return new dropdown_format_1.default();
    }
}
exports.default = Format;
//# sourceMappingURL=format.js.map