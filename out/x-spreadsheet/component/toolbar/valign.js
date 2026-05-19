"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dropdown_item_1 = __importDefault(require("./dropdown_item"));
const dropdown_align_1 = __importDefault(require("../dropdown_align"));
class Valign extends dropdown_item_1.default {
    constructor(value) {
        super('valign', '', value);
    }
    dropdown() {
        const { value } = this;
        return new dropdown_align_1.default(['top', 'middle', 'bottom'], value);
    }
}
exports.default = Valign;
//# sourceMappingURL=valign.js.map