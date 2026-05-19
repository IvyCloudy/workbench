"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/* global document */
/* global window */
const element_1 = require("./element");
const icon_1 = __importDefault(require("./icon"));
const config_1 = require("../config");
const event_1 = require("./event");
class Modal {
    constructor(title, content, width = '600px') {
        this.title = title;
        this.el = (0, element_1.h)('div', `${config_1.cssPrefix}-modal`).css('width', width).children((0, element_1.h)('div', `${config_1.cssPrefix}-modal-header`).children(new icon_1.default('close').on('click.stop', () => this.hide()), this.title), (0, element_1.h)('div', `${config_1.cssPrefix}-modal-content`).children(...content)).hide();
    }
    show() {
        // dimmer
        this.dimmer = (0, element_1.h)('div', `${config_1.cssPrefix}-dimmer active`);
        document.body.appendChild(this.dimmer.el);
        const { width, height } = this.el.show().box();
        const { clientHeight, clientWidth } = document.documentElement;
        this.el.offset({
            left: (clientWidth - width) / 2,
            top: (clientHeight - height) / 3,
        });
        window.xkeydownEsc = (evt) => {
            if (evt.keyCode === 27) {
                this.hide();
            }
        };
        (0, event_1.bind)(window, 'keydown', window.xkeydownEsc);
    }
    hide() {
        this.el.hide();
        document.body.removeChild(this.dimmer.el);
        (0, event_1.unbind)(window, 'keydown', window.xkeydownEsc);
        delete window.xkeydownEsc;
    }
}
exports.default = Modal;
//# sourceMappingURL=modal.js.map