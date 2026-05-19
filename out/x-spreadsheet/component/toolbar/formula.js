"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dropdown_item_1 = __importDefault(require("./dropdown_item"));
const dropdown_formula_1 = __importDefault(require("../dropdown_formula"));
class Format extends dropdown_item_1.default {
    constructor() {
        super('formula');
    }
    getValue(it) {
        return it.key;
    }
    dropdown() {
        return new dropdown_formula_1.default();
    }
}
exports.default = Format;
//# sourceMappingURL=formula.js.map