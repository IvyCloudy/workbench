"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const element_1 = require("./element");
const config_1 = require("../config");
class Icon extends element_1.Element {
    constructor(name) {
        super('div', `${config_1.cssPrefix}-icon`);
        this.iconNameEl = (0, element_1.h)('div', `${config_1.cssPrefix}-icon-img ${name}`);
        this.child(this.iconNameEl);
    }
    setName(name) {
        this.iconNameEl.className(`${config_1.cssPrefix}-icon-img ${name}`);
    }
}
exports.default = Icon;
//# sourceMappingURL=icon.js.map