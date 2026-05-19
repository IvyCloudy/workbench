"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dropdown_item_1 = __importDefault(require("./dropdown_item"));
const dropdown_border_1 = __importDefault(require("../dropdown_border"));
class Border extends dropdown_item_1.default {
    constructor() {
        super('border');
    }
    dropdown() {
        return new dropdown_border_1.default();
    }
}
exports.default = Border;
//# sourceMappingURL=border.js.map