"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const element_1 = require("./element");
const config_1 = require("../config");
class FormInput {
    constructor(width, hint) {
        this.vchange = () => { };
        this.el = (0, element_1.h)('div', `${config_1.cssPrefix}-form-input`);
        this.input = (0, element_1.h)('input', '').css('width', width)
            .on('input', evt => this.vchange(evt))
            .attr('placeholder', hint);
        this.el.child(this.input);
    }
    focus() {
        setTimeout(() => {
            this.input.el.focus();
        }, 10);
    }
    hint(v) {
        this.input.attr('placeholder', v);
    }
    val(v) {
        return this.input.val(v);
    }
}
exports.default = FormInput;
//# sourceMappingURL=form_input.js.map