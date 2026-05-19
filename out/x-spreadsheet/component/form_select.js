"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const element_1 = require("./element");
const suggest_1 = __importDefault(require("./suggest"));
const config_1 = require("../config");
class FormSelect {
    constructor(key, items, width, getTitle = it => it, change = () => { }) {
        this.key = key;
        this.getTitle = getTitle;
        this.vchange = () => { };
        this.el = (0, element_1.h)('div', `${config_1.cssPrefix}-form-select`);
        this.suggest = new suggest_1.default(items.map(it => ({ key: it, title: this.getTitle(it) })), (it) => {
            this.itemClick(it.key);
            change(it.key);
            this.vchange(it.key);
        }, width, this.el);
        this.el.children(this.itemEl = (0, element_1.h)('div', 'input-text').html(this.getTitle(key)), this.suggest.el).on('click', () => this.show());
    }
    show() {
        this.suggest.search('');
    }
    itemClick(it) {
        this.key = it;
        this.itemEl.html(this.getTitle(it));
    }
    val(v) {
        if (v !== undefined) {
            this.key = v;
            this.itemEl.html(this.getTitle(v));
            return this;
        }
        return this.key;
    }
}
exports.default = FormSelect;
//# sourceMappingURL=form_select.js.map