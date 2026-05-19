"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const toggle_item_1 = __importDefault(require("./toggle_item"));
class Bold extends toggle_item_1.default {
    constructor() {
        super('font-bold', 'Ctrl+B');
    }
}
exports.default = Bold;
//# sourceMappingURL=bold.js.map