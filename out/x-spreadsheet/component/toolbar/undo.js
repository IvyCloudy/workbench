"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const icon_item_1 = __importDefault(require("./icon_item"));
class Undo extends icon_item_1.default {
    constructor() {
        super('undo', 'Ctrl+Z');
    }
}
exports.default = Undo;
//# sourceMappingURL=undo.js.map