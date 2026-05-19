"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const element_1 = require("./element");
const event_1 = require("./event");
const config_1 = require("../config");
const icon_1 = __importDefault(require("./icon"));
const form_input_1 = __importDefault(require("./form_input"));
const dropdown_1 = __importDefault(require("./dropdown"));
// Record: temp not used
// import { xtoast } from './message';
const locale_1 = require("../locale/locale");
const menuItems = [
    { key: 'delete', title: (0, locale_1.tf)('contextmenu.deleteSheet') },
];
function buildMenuItem(item) {
    return (0, element_1.h)('div', `${config_1.cssPrefix}-item`)
        .child(item.title())
        .on('click', () => {
        this.itemClick(item.key);
        this.hide();
    });
}
function buildMenu() {
    return menuItems.map(it => buildMenuItem.call(this, it));
}
class ContextMenu {
    constructor() {
        this.el = (0, element_1.h)('div', `${config_1.cssPrefix}-contextmenu`)
            .css('width', '160px')
            .children(...buildMenu.call(this))
            .hide();
        this.itemClick = () => { };
    }
    hide() {
        const { el } = this;
        el.hide();
        (0, event_1.unbindClickoutside)(el);
    }
    setOffset(offset) {
        const { el } = this;
        el.offset(offset);
        el.show();
        (0, event_1.bindClickoutside)(el);
    }
}
class Bottombar {
    constructor(addFunc = () => { }, swapFunc = () => { }, deleteFunc = () => { }, updateFunc = () => { }) {
        this.swapFunc = swapFunc;
        this.updateFunc = updateFunc;
        this.dataNames = [];
        this.activeEl = null;
        this.deleteEl = null;
        this.items = [];
        this.contextMenu = new ContextMenu();
        this.contextMenu.itemClick = deleteFunc;
        this.el = (0, element_1.h)('div', `${config_1.cssPrefix}-bottombar`).children(this.contextMenu.el, this.menuEl = (0, element_1.h)('ul', `${config_1.cssPrefix}-menu`).child((0, element_1.h)('li', '').children(new icon_1.default('add').on('click', () => {
            addFunc();
        }))));
    }
    addItem(name, active, options) {
        this.dataNames.push(name);
        const item = (0, element_1.h)('li', active ? 'active' : '').child(name);
        item.on('click', () => {
            this.clickSwap2(item);
        }).on('contextmenu', (evt) => {
            if (options.mode === 'read')
                return;
            const { offsetLeft, offsetHeight } = evt.target;
            this.contextMenu.setOffset({ left: offsetLeft, bottom: offsetHeight + 1 });
            this.deleteEl = item;
        }).on('dblclick', () => {
            if (options.mode === 'read')
                return;
            const v = item.html();
            const input = new form_input_1.default('auto', '');
            input.val(v);
            input.input.on('blur', ({ target }) => {
                const { value } = target;
                const nindex = this.dataNames.findIndex(it => it === v);
                this.renameItem(nindex, value);
            });
            item.html('').child(input.el);
            input.focus();
        });
        if (active) {
            this.clickSwap(item);
        }
        this.items.push(item);
        this.menuEl.child(item);
    }
    renameItem(index, value) {
        this.dataNames.splice(index, 1, value);
        this.items[index].html('').child(value);
        this.updateFunc(index, value);
    }
    clear() {
        this.items.forEach((it) => {
            this.menuEl.removeChild(it.el);
        });
        this.items = [];
        this.dataNames = [];
    }
    deleteItem() {
        const { activeEl, deleteEl } = this;
        if (this.items.length > 1) {
            const index = this.items.findIndex(it => it === deleteEl);
            this.items.splice(index, 1);
            this.dataNames.splice(index, 1);
            this.menuEl.removeChild(deleteEl.el);
            if (activeEl === deleteEl) {
                const [f] = this.items;
                this.activeEl = f;
                this.activeEl.toggle();
                return [index, 0];
            }
            return [index, -1];
        }
        return [-1];
    }
    clickSwap2(item) {
        const index = this.items.findIndex(it => it === item);
        this.clickSwap(item);
        this.activeEl.toggle();
        this.swapFunc(index);
    }
    clickSwap(item) {
        if (this.activeEl !== null) {
            this.activeEl.toggle();
        }
        this.activeEl = item;
    }
}
exports.default = Bottombar;
//# sourceMappingURL=bottombar.js.map