"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dropdown_1 = __importDefault(require("./dropdown"));
const icon_1 = __importDefault(require("./icon"));
const element_1 = require("./element");
const formula_1 = require("../core/formula");
const config_1 = require("../config");
class DropdownFormula extends dropdown_1.default {
    constructor() {
        const nformulas = formula_1.baseFormulas.map(it => (0, element_1.h)('div', `${config_1.cssPrefix}-item`)
            .on('click', () => {
            this.hide();
            this.change(it);
        })
            .child(it.key));
        super(new icon_1.default('formula'), '180px', true, 'bottom-left', ...nformulas);
    }
}
exports.default = DropdownFormula;
//# sourceMappingURL=dropdown_formula.js.map