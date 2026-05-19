"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const toggle_item_1 = __importDefault(require("./toggle_item"));
class Merge extends toggle_item_1.default {
    constructor() {
        super('merge');
    }
    setState(active, disabled) {
        this.el.active(active).disabled(disabled);
    }
}
exports.default = Merge;
//# sourceMappingURL=merge.js.map