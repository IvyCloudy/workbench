"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const element_1 = require("./element");
const event_1 = require("./event");
const config_1 = require("../config");
const locale_1 = require("../locale/locale");
const menuItems = [
    { key: 'copy', title: (0, locale_1.tf)('contextmenu.copy'), label: 'Ctrl+C' },
    { key: 'cut', title: (0, locale_1.tf)('contextmenu.cut'), label: 'Ctrl+X' },
    { key: 'paste', title: (0, locale_1.tf)('contextmenu.paste'), label: 'Ctrl+V' },
    { key: 'paste-value', title: (0, locale_1.tf)('contextmenu.pasteValue'), label: 'Ctrl+Shift+V' },
    { key: 'paste-format', title: (0, locale_1.tf)('contextmenu.pasteFormat'), label: 'Ctrl+Alt+V' },
    { key: 'divider' },
    { key: 'insert-row', title: (0, locale_1.tf)('contextmenu.insertRow') },
    { key: 'insert-column', title: (0, locale_1.tf)('contextmenu.insertColumn') },
    { key: 'divider' },
    { key: 'delete-row', title: (0, locale_1.tf)('contextmenu.deleteRow') },
    { key: 'delete-column', title: (0, locale_1.tf)('contextmenu.deleteColumn') },
    { key: 'delete-cell-text', title: (0, locale_1.tf)('contextmenu.deleteCellText') },
    { key: 'hide', title: (0, locale_1.tf)('contextmenu.hide') },
    { key: 'divider' },
    { key: 'validation', title: (0, locale_1.tf)('contextmenu.validation') },
    { key: 'divider' },
    { key: 'cell-printable', title: (0, locale_1.tf)('contextmenu.cellprintable') },
    { key: 'cell-non-printable', title: (0, locale_1.tf)('contextmenu.cellnonprintable') },
    { key: 'divider' },
    { key: 'cell-editable', title: (0, locale_1.tf)('contextmenu.celleditable') },
    { key: 'cell-non-editable', title: (0, locale_1.tf)('contextmenu.cellnoneditable') },
];
function buildMenuItem(item) {
    if (item.key === 'divider') {
        return (0, element_1.h)('div', `${config_1.cssPrefix}-item divider`);
    }
    return (0, element_1.h)('div', `${config_1.cssPrefix}-item`)
        .on('click', () => {
        this.itemClick(item.key);
        this.hide();
    })
        .children(item.title(), (0, element_1.h)('div', 'label').child(item.label || ''));
}
function buildMenu() {
    return menuItems.map(it => buildMenuItem.call(this, it));
}
class ContextMenu {
    constructor(viewFn, isHide = false) {
        this.menuItems = buildMenu.call(this);
        this.el = (0, element_1.h)('div', `${config_1.cssPrefix}-contextmenu`)
            .children(...this.menuItems)
            .hide();
        this.viewFn = viewFn;
        this.itemClick = () => { };
        this.isHide = isHide;
        this.setMode('range');
    }
    // row-col: the whole rows or the whole cols
    // range: select range
    setMode(mode) {
        const hideEl = this.menuItems[12];
        if (mode === 'row-col') {
            hideEl.show();
        }
        else {
            hideEl.hide();
        }
    }
    hide() {
        const { el } = this;
        el.hide();
        (0, event_1.unbindClickoutside)(el);
    }
    setPosition(x, y) {
        if (this.isHide)
            return;
        const { el } = this;
        const { width } = el.show().offset();
        const view = this.viewFn();
        const vhf = view.height / 2;
        let left = x;
        if (view.width - x <= width) {
            left -= width;
        }
        el.css('left', `${left}px`);
        if (y > vhf) {
            el.css('bottom', `${view.height - y}px`)
                .css('max-height', `${y}px`)
                .css('top', 'auto');
        }
        else {
            el.css('top', `${y}px`)
                .css('max-height', `${view.height - y}px`)
                .css('bottom', 'auto');
        }
        (0, event_1.bindClickoutside)(el);
    }
}
exports.default = ContextMenu;
//# sourceMappingURL=contextmenu.js.map