"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const item_1 = __importDefault(require("./item"));
const icon_1 = __importDefault(require("../icon"));
class IconItem extends item_1.default {
    element() {
        return super.element()
            .child(new icon_1.default(this.tag))
            .on('click', () => this.change(this.tag));
    }
    setState(disabled) {
        this.el.disabled(disabled);
    }
}
exports.default = IconItem;
//# sourceMappingURL=icon_item.js.map