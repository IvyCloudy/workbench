"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const modal_1 = __importDefault(require("./modal"));
const form_input_1 = __importDefault(require("./form_input"));
const form_select_1 = __importDefault(require("./form_select"));
const form_field_1 = __importDefault(require("./form_field"));
const button_1 = __importDefault(require("./button"));
const locale_1 = require("../locale/locale");
const element_1 = require("./element");
const config_1 = require("../config");
const fieldLabelWidth = 100;
class ModalValidation extends modal_1.default {
    constructor() {
        const mf = new form_field_1.default(new form_select_1.default('cell', ['cell'], // cell|row|column
        '100%', it => (0, locale_1.t)(`dataValidation.modeType.${it}`)), { required: true }, `${(0, locale_1.t)('dataValidation.range')}:`, fieldLabelWidth);
        const rf = new form_field_1.default(new form_input_1.default('120px', 'E3 or E3:F12'), { required: true, pattern: /^([A-Z]{1,2}[1-9]\d*)(:[A-Z]{1,2}[1-9]\d*)?$/ });
        const cf = new form_field_1.default(new form_select_1.default('list', ['list', 'number', 'date', 'phone', 'email'], '100%', it => (0, locale_1.t)(`dataValidation.type.${it}`), it => this.criteriaSelected(it)), { required: true }, `${(0, locale_1.t)('dataValidation.criteria')}:`, fieldLabelWidth);
        // operator
        const of = new form_field_1.default(new form_select_1.default('be', ['be', 'nbe', 'eq', 'neq', 'lt', 'lte', 'gt', 'gte'], '160px', it => (0, locale_1.t)(`dataValidation.operator.${it}`), it => this.criteriaOperatorSelected(it)), { required: true }).hide();
        // min, max
        const minvf = new form_field_1.default(new form_input_1.default('70px', '10'), { required: true }).hide();
        const maxvf = new form_field_1.default(new form_input_1.default('70px', '100'), { required: true, type: 'number' }).hide();
        // value
        const svf = new form_field_1.default(new form_input_1.default('120px', 'a,b,c'), { required: true });
        const vf = new form_field_1.default(new form_input_1.default('70px', '10'), { required: true, type: 'number' }).hide();
        super((0, locale_1.t)('contextmenu.validation'), [
            (0, element_1.h)('div', `${config_1.cssPrefix}-form-fields`).children(mf.el, rf.el),
            (0, element_1.h)('div', `${config_1.cssPrefix}-form-fields`).children(cf.el, of.el, minvf.el, maxvf.el, vf.el, svf.el),
            (0, element_1.h)('div', `${config_1.cssPrefix}-buttons`).children(new button_1.default('cancel').on('click', () => this.btnClick('cancel')), new button_1.default('remove').on('click', () => this.btnClick('remove')), new button_1.default('save', 'primary').on('click', () => this.btnClick('save'))),
        ]);
        this.mf = mf;
        this.rf = rf;
        this.cf = cf;
        this.of = of;
        this.minvf = minvf;
        this.maxvf = maxvf;
        this.vf = vf;
        this.svf = svf;
        this.change = () => { };
    }
    showVf(it) {
        const hint = it === 'date' ? '2018-11-12' : '10';
        const { vf } = this;
        vf.input.hint(hint);
        vf.show();
    }
    criteriaSelected(it) {
        const { of, minvf, maxvf, vf, svf, } = this;
        if (it === 'date' || it === 'number') {
            of.show();
            minvf.rule.type = it;
            maxvf.rule.type = it;
            if (it === 'date') {
                minvf.hint('2018-11-12');
                maxvf.hint('2019-11-12');
            }
            else {
                minvf.hint('10');
                maxvf.hint('100');
            }
            minvf.show();
            maxvf.show();
            vf.hide();
            svf.hide();
        }
        else {
            if (it === 'list') {
                svf.show();
            }
            else {
                svf.hide();
            }
            vf.hide();
            of.hide();
            minvf.hide();
            maxvf.hide();
        }
    }
    criteriaOperatorSelected(it) {
        if (!it)
            return;
        const { minvf, maxvf, vf, } = this;
        if (it === 'be' || it === 'nbe') {
            minvf.show();
            maxvf.show();
            vf.hide();
        }
        else {
            const type = this.cf.val();
            vf.rule.type = type;
            if (type === 'date') {
                vf.hint('2018-11-12');
            }
            else {
                vf.hint('10');
            }
            vf.show();
            minvf.hide();
            maxvf.hide();
        }
    }
    btnClick(action) {
        if (action === 'cancel') {
            this.hide();
        }
        else if (action === 'remove') {
            this.change('remove');
            this.hide();
        }
        else if (action === 'save') {
            // validate
            const attrs = ['mf', 'rf', 'cf', 'of', 'svf', 'vf', 'minvf', 'maxvf'];
            for (let i = 0; i < attrs.length; i += 1) {
                const field = this[attrs[i]];
                // console.log('field:', field);
                if (field.isShow()) {
                    // console.log('it:', it);
                    if (!field.validate())
                        return;
                }
            }
            const mode = this.mf.val();
            const ref = this.rf.val();
            const type = this.cf.val();
            const operator = this.of.val();
            let value = this.svf.val();
            if (type === 'number' || type === 'date') {
                if (operator === 'be' || operator === 'nbe') {
                    value = [this.minvf.val(), this.maxvf.val()];
                }
                else {
                    value = this.vf.val();
                }
            }
            // console.log(mode, ref, type, operator, value);
            this.change('save', mode, ref, {
                type, operator, required: false, value,
            });
            this.hide();
        }
    }
    // validation: { mode, ref, validator }
    setValue(v) {
        if (v) {
            const { mf, rf, cf, of, svf, vf, minvf, maxvf, } = this;
            const { mode, ref, validator, } = v;
            const { type, operator, value, } = validator || { type: 'list' };
            mf.val(mode || 'cell');
            rf.val(ref);
            cf.val(type);
            of.val(operator);
            if (Array.isArray(value)) {
                minvf.val(value[0]);
                maxvf.val(value[1]);
            }
            else {
                svf.val(value || '');
                vf.val(value || '');
            }
            this.criteriaSelected(type);
            this.criteriaOperatorSelected(operator);
        }
        this.show();
    }
}
exports.default = ModalValidation;
//# sourceMappingURL=modal_validation.js.map