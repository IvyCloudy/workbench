"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.xtoast = xtoast;
/* global document */
const element_1 = require("./element");
const icon_1 = __importDefault(require("./icon"));
const config_1 = require("../config");
function xtoast(title, content) {
    const el = (0, element_1.h)('div', `${config_1.cssPrefix}-toast`);
    const dimmer = (0, element_1.h)('div', `${config_1.cssPrefix}-dimmer active`);
    const remove = () => {
        document.body.removeChild(el.el);
        document.body.removeChild(dimmer.el);
    };
    el.children((0, element_1.h)('div', `${config_1.cssPrefix}-toast-header`).children(new icon_1.default('close').on('click.stop', () => remove()), title), (0, element_1.h)('div', `${config_1.cssPrefix}-toast-content`).html(content));
    document.body.appendChild(el.el);
    document.body.appendChild(dimmer.el);
    // set offset
    const { width, height } = el.box();
    const { clientHeight, clientWidth } = document.documentElement;
    el.offset({
        left: (clientWidth - width) / 2,
        top: (clientHeight - height) / 3,
    });
}
exports.default = {};
//# sourceMappingURL=message.js.map