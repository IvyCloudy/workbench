"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const element_1 = require("./element");
const event_1 = require("./event");
const config_1 = require("../config");
class Dropdown extends element_1.Element {
    constructor(title, width, showArrow, placement, ...children) {
        super('div', `${config_1.cssPrefix}-dropdown ${placement}`);
        this.title = title;
        this.change = () => { };
        this.headerClick = () => { };
        if (typeof title === 'string') {
            this.title = (0, element_1.h)('div', `${config_1.cssPrefix}-dropdown-title`).child(title);
        }
        else if (showArrow) {
            this.title.addClass('arrow-left');
        }
        this.contentEl = (0, element_1.h)('div', `${config_1.cssPrefix}-dropdown-content`)
            .css('width', width)
            .hide();
        this.setContentChildren(...children);
        this.headerEl = (0, element_1.h)('div', `${config_1.cssPrefix}-dropdown-header`);
        this.headerEl.on('click', () => {
            if (this.contentEl.css('display') !== 'block') {
                this.show();
            }
            else {
                this.hide();
            }
        }).children(this.title, showArrow ? (0, element_1.h)('div', `${config_1.cssPrefix}-icon arrow-right`).child((0, element_1.h)('div', `${config_1.cssPrefix}-icon-img arrow-down`)) : '');
        this.children(this.headerEl, this.contentEl);
    }
    setContentChildren(...children) {
        this.contentEl.html('');
        if (children.length > 0) {
            this.contentEl.children(...children);
        }
    }
    setTitle(title) {
        this.title.html(title);
        this.hide();
    }
    show() {
        const { contentEl } = this;
        contentEl.show();
        this.parent().active();
        (0, event_1.bindClickoutside)(this.parent(), () => {
            this.hide();
        });
    }
    hide() {
        this.parent().active(false);
        this.contentEl.hide();
        (0, event_1.unbindClickoutside)(this.parent());
    }
}
exports.default = Dropdown;
//# sourceMappingURL=dropdown.js.map