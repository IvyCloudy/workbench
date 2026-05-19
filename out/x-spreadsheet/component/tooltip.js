"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = tooltip;
/* global document */
const element_1 = require("./element");
const event_1 = require("./event");
const config_1 = require("../config");
function tooltip(html, target) {
    if (target.classList.contains('active')) {
        return;
    }
    const { left, top, width, height, } = target.getBoundingClientRect();
    const el = (0, element_1.h)('div', `${config_1.cssPrefix}-tooltip`).html(html).show();
    document.body.appendChild(el.el);
    const elBox = el.box();
    // console.log('elBox:', elBox);
    el.css('left', `${left + (width / 2) - (elBox.width / 2)}px`)
        .css('top', `${top + height + 2}px`);
    (0, event_1.bind)(target, 'mouseleave', () => {
        if (document.body.contains(el.el)) {
            document.body.removeChild(el.el);
        }
    });
    (0, event_1.bind)(target, 'click', () => {
        if (document.body.contains(el.el)) {
            document.body.removeChild(el.el);
        }
    });
}
//# sourceMappingURL=tooltip.js.map