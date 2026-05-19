"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const item_1 = __importDefault(require("./item"));
class DropdownItem extends item_1.default {
    dropdown() { }
    getValue(v) {
        return v;
    }
    element() {
        const { tag } = this;
        this.dd = this.dropdown();
        this.dd.change = it => this.change(tag, this.getValue(it));
        return super.element().child(this.dd);
    }
    setState(v) {
        if (v) {
            this.value = v;
            this.dd.setTitle(v);
        }
    }
}
exports.default = DropdownItem;
//# sourceMappingURL=dropdown_item.js.map