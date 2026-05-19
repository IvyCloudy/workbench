"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const element_1 = require("./element");
const config_1 = require("../config");
const locale_1 = require("../locale/locale");
const patterns = {
    number: /(^\d+$)|(^\d+(\.\d{0,4})?$)/,
    date: /^\d{4}-\d{1,2}-\d{1,2}$/,
};
// rule: { required: false, type, pattern: // }
class FormField {
    constructor(input, rule, label, labelWidth) {
        this.label = '';
        this.rule = rule;
        if (label) {
            this.label = (0, element_1.h)('label', 'label').css('width', `${labelWidth}px`).html(label);
        }
        this.tip = (0, element_1.h)('div', 'tip').child('tip').hide();
        this.input = input;
        this.input.vchange = () => this.validate();
        this.el = (0, element_1.h)('div', `${config_1.cssPrefix}-form-field`)
            .children(this.label, input.el, this.tip);
    }
    isShow() {
        return this.el.css('display') !== 'none';
    }
    show() {
        this.el.show();
    }
    hide() {
        this.el.hide();
        return this;
    }
    val(v) {
        return this.input.val(v);
    }
    hint(hint) {
        this.input.hint(hint);
    }
    validate() {
        const { input, rule, tip, el, } = this;
        const v = input.val();
        if (rule.required) {
            if (/^\s*$/.test(v)) {
                tip.html((0, locale_1.t)('validation.required'));
                el.addClass('error');
                return false;
            }
        }
        if (rule.type || rule.pattern) {
            const pattern = rule.pattern || patterns[rule.type];
            if (!pattern.test(v)) {
                tip.html((0, locale_1.t)('validation.notMatch'));
                el.addClass('error');
                return false;
            }
        }
        el.removeClass('error');
        return true;
    }
}
exports.default = FormField;
//# sourceMappingURL=form_field.js.map