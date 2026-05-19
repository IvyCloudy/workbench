"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const item_1 = __importDefault(require("./item"));
const icon_1 = __importDefault(require("../icon"));
class ToggleItem extends item_1.default {
    element() {
        const { tag } = this;
        return super.element()
            .child(new icon_1.default(tag))
            .on('click', () => this.click());
    }
    click() {
        this.change(this.tag, this.toggle());
    }
    setState(active) {
        this.el.active(active);
    }
    toggle() {
        return this.el.toggle();
    }
    active() {
        return this.el.hasClass('active');
    }
}
exports.default = ToggleItem;
//# sourceMappingURL=toggle_item.js.map