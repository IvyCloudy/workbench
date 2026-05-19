"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const element_1 = require("./element");
const config_1 = require("../config");
const locale_1 = require("../locale/locale");
class Button extends element_1.Element {
    // type: primary
    constructor(title, type = '') {
        super('div', `${config_1.cssPrefix}-button ${type}`);
        this.child((0, locale_1.t)(`button.${title}`));
    }
}
exports.default = Button;
//# sourceMappingURL=button.js.map