"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const element_1 = require("./element");
const event_1 = require("./event");
const config_1 = require("../config");
function inputMovePrev(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const { filterItems } = this;
    if (filterItems.length <= 0)
        return;
    if (this.itemIndex >= 0)
        filterItems[this.itemIndex].toggle();
    this.itemIndex -= 1;
    if (this.itemIndex < 0) {
        this.itemIndex = filterItems.length - 1;
    }
    filterItems[this.itemIndex].toggle();
}
function inputMoveNext(evt) {
    evt.stopPropagation();
    const { filterItems } = this;
    if (filterItems.length <= 0)
        return;
    if (this.itemIndex >= 0)
        filterItems[this.itemIndex].toggle();
    this.itemIndex += 1;
    if (this.itemIndex > filterItems.length - 1) {
        this.itemIndex = 0;
    }
    filterItems[this.itemIndex].toggle();
}
function inputEnter(evt) {
    evt.preventDefault();
    const { filterItems } = this;
    if (filterItems.length <= 0)
        return;
    evt.stopPropagation();
    if (this.itemIndex < 0)
        this.itemIndex = 0;
    filterItems[this.itemIndex].el.click();
    this.hide();
}
function inputKeydownHandler(evt) {
    const { keyCode } = evt;
    if (evt.ctrlKey) {
        evt.stopPropagation();
    }
    switch (keyCode) {
        case 37: // left
            evt.stopPropagation();
            break;
        case 38: // up
            inputMovePrev.call(this, evt);
            break;
        case 39: // right
            evt.stopPropagation();
            break;
        case 40: // down
            inputMoveNext.call(this, evt);
            break;
        case 13: // enter
            inputEnter.call(this, evt);
            break;
        case 9:
            inputEnter.call(this, evt);
            break;
        default:
            evt.stopPropagation();
            break;
    }
}
class Suggest {
    constructor(items, itemClick, width = '200px') {
        this.filterItems = [];
        this.items = items;
        this.el = (0, element_1.h)('div', `${config_1.cssPrefix}-suggest`).css('width', width).hide();
        this.itemClick = itemClick;
        this.itemIndex = -1;
    }
    setOffset(v) {
        this.el.cssRemoveKeys('top', 'bottom')
            .offset(v);
    }
    hide() {
        const { el } = this;
        this.filterItems = [];
        this.itemIndex = -1;
        el.hide();
        (0, event_1.unbindClickoutside)(this.el.parent());
    }
    setItems(items) {
        this.items = items;
        // this.search('');
    }
    search(word) {
        let { items } = this;
        if (!/^\s*$/.test(word)) {
            items = items.filter(it => (it.key || it).startsWith(word.toUpperCase()));
        }
        items = items.map((it) => {
            let { title } = it;
            if (title) {
                if (typeof title === 'function') {
                    title = title();
                }
            }
            else {
                title = it;
            }
            const item = (0, element_1.h)('div', `${config_1.cssPrefix}-item`)
                .child(title)
                .on('click.stop', () => {
                this.itemClick(it);
                this.hide();
            });
            if (it.label) {
                item.child((0, element_1.h)('div', 'label').html(it.label));
            }
            return item;
        });
        this.filterItems = items;
        if (items.length <= 0) {
            return;
        }
        const { el } = this;
        // items[0].toggle();
        el.html('').children(...items).show();
        (0, event_1.bindClickoutside)(el.parent(), () => { this.hide(); });
    }
    bindInputEvents(input) {
        input.on('keydown', evt => inputKeydownHandler.call(this, evt));
    }
}
exports.default = Suggest;
//# sourceMappingURL=suggest.js.map