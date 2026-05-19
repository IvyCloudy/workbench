"use strict";
/* global window */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const align_1 = __importDefault(require("./align"));
const valign_1 = __importDefault(require("./valign"));
const autofilter_1 = __importDefault(require("./autofilter"));
const bold_1 = __importDefault(require("./bold"));
const italic_1 = __importDefault(require("./italic"));
const strike_1 = __importDefault(require("./strike"));
const underline_1 = __importDefault(require("./underline"));
const border_1 = __importDefault(require("./border"));
const clearformat_1 = __importDefault(require("./clearformat"));
const paintformat_1 = __importDefault(require("./paintformat"));
const text_color_1 = __importDefault(require("./text_color"));
const fill_color_1 = __importDefault(require("./fill_color"));
const font_size_1 = __importDefault(require("./font_size"));
const font_1 = __importDefault(require("./font"));
const format_1 = __importDefault(require("./format"));
const formula_1 = __importDefault(require("./formula"));
const freeze_1 = __importDefault(require("./freeze"));
const merge_1 = __importDefault(require("./merge"));
const redo_1 = __importDefault(require("./redo"));
const undo_1 = __importDefault(require("./undo"));
const print_1 = __importDefault(require("./print"));
const textwrap_1 = __importDefault(require("./textwrap"));
const more_1 = __importDefault(require("./more"));
const item_1 = __importDefault(require("./item"));
const element_1 = require("../element");
const config_1 = require("../../config");
const event_1 = require("../event");
function buildDivider() {
    return (0, element_1.h)('div', `${config_1.cssPrefix}-toolbar-divider`);
}
function initBtns2() {
    this.btns2 = [];
    this.items.forEach((it) => {
        if (Array.isArray(it)) {
            it.forEach(({ el }) => {
                const rect = el.box();
                const { marginLeft, marginRight } = el.computedStyle();
                this.btns2.push([el, rect.width + parseInt(marginLeft, 10) + parseInt(marginRight, 10)]);
            });
        }
        else {
            const rect = it.box();
            const { marginLeft, marginRight } = it.computedStyle();
            this.btns2.push([it, rect.width + parseInt(marginLeft, 10) + parseInt(marginRight, 10)]);
        }
    });
}
function moreResize() {
    const { el, btns, moreEl, btns2, } = this;
    const { moreBtns, contentEl } = moreEl.dd;
    el.css('width', `${this.widthFn()}px`);
    const elBox = el.box();
    let sumWidth = 160;
    let sumWidth2 = 12;
    const list1 = [];
    const list2 = [];
    btns2.forEach(([it, w], index) => {
        sumWidth += w;
        if (index === btns2.length - 1 || sumWidth < elBox.width) {
            list1.push(it);
        }
        else {
            sumWidth2 += w;
            list2.push(it);
        }
    });
    btns.html('').children(...list1);
    moreBtns.html('').children(...list2);
    contentEl.css('width', `${sumWidth2}px`);
    if (list2.length > 0) {
        moreEl.show();
    }
    else {
        moreEl.hide();
    }
}
function genBtn(it) {
    const btn = new item_1.default();
    btn.el.on('click', () => {
        if (it.onClick)
            it.onClick(this.data.getData(), this.data);
    });
    btn.tip = it.tip || '';
    let { el } = it;
    if (it.icon) {
        el = (0, element_1.h)('img').attr('src', it.icon);
    }
    if (el) {
        const icon = (0, element_1.h)('div', `${config_1.cssPrefix}-icon`);
        icon.child(el);
        btn.el.child(icon);
    }
    return btn;
}
class Toolbar {
    constructor(data, widthFn, isHide = false) {
        this.data = data;
        this.change = () => { };
        this.widthFn = widthFn;
        this.isHide = isHide;
        const style = data.defaultStyle();
        this.items = [
            [
                this.undoEl = new undo_1.default(),
                this.redoEl = new redo_1.default(),
                new print_1.default(),
                this.paintformatEl = new paintformat_1.default(),
                this.clearformatEl = new clearformat_1.default(),
            ],
            buildDivider(),
            [
                this.formatEl = new format_1.default(),
            ],
            buildDivider(),
            [
                this.fontEl = new font_1.default(),
                this.fontSizeEl = new font_size_1.default(),
            ],
            buildDivider(),
            [
                this.boldEl = new bold_1.default(),
                this.italicEl = new italic_1.default(),
                this.underlineEl = new underline_1.default(),
                this.strikeEl = new strike_1.default(),
                this.textColorEl = new text_color_1.default(style.color),
            ],
            buildDivider(),
            [
                this.fillColorEl = new fill_color_1.default(style.bgcolor),
                this.borderEl = new border_1.default(),
                this.mergeEl = new merge_1.default(),
            ],
            buildDivider(),
            [
                this.alignEl = new align_1.default(style.align),
                this.valignEl = new valign_1.default(style.valign),
                this.textwrapEl = new textwrap_1.default(),
            ],
            buildDivider(),
            [
                this.freezeEl = new freeze_1.default(),
                this.autofilterEl = new autofilter_1.default(),
                this.formulaEl = new formula_1.default(),
            ],
        ];
        const { extendToolbar = {} } = data.settings;
        if (extendToolbar.left && extendToolbar.left.length > 0) {
            this.items.unshift(buildDivider());
            const btns = extendToolbar.left.map(genBtn.bind(this));
            this.items.unshift(btns);
        }
        if (extendToolbar.right && extendToolbar.right.length > 0) {
            this.items.push(buildDivider());
            const btns = extendToolbar.right.map(genBtn.bind(this));
            this.items.push(btns);
        }
        this.items.push([this.moreEl = new more_1.default()]);
        this.el = (0, element_1.h)('div', `${config_1.cssPrefix}-toolbar`);
        this.btns = (0, element_1.h)('div', `${config_1.cssPrefix}-toolbar-btns`);
        this.items.forEach((it) => {
            if (Array.isArray(it)) {
                it.forEach((i) => {
                    this.btns.child(i.el);
                    i.change = (...args) => {
                        this.change(...args);
                    };
                });
            }
            else {
                this.btns.child(it.el);
            }
        });
        this.el.child(this.btns);
        if (isHide) {
            this.el.hide();
        }
        else {
            this.reset();
            setTimeout(() => {
                initBtns2.call(this);
                moreResize.call(this);
            }, 0);
            (0, event_1.bind)(window, 'resize', () => {
                moreResize.call(this);
            });
        }
    }
    paintformatActive() {
        return this.paintformatEl.active();
    }
    paintformatToggle() {
        this.paintformatEl.toggle();
    }
    trigger(type) {
        this[`${type}El`].click();
    }
    resetData(data) {
        this.data = data;
        this.reset();
    }
    reset() {
        if (this.isHide)
            return;
        const { data } = this;
        const style = data.getSelectedCellStyle();
        // console.log('canUndo:', data.canUndo());
        this.undoEl.setState(!data.canUndo());
        this.redoEl.setState(!data.canRedo());
        this.mergeEl.setState(data.canUnmerge(), !data.selector.multiple());
        this.autofilterEl.setState(!data.canAutofilter());
        // this.mergeEl.disabled();
        // console.log('selectedCell:', style, cell);
        const { font, format } = style;
        this.formatEl.setState(format);
        this.fontEl.setState(font.name);
        this.fontSizeEl.setState(font.size);
        this.boldEl.setState(font.bold);
        this.italicEl.setState(font.italic);
        this.underlineEl.setState(style.underline);
        this.strikeEl.setState(style.strike);
        this.textColorEl.setState(style.color);
        this.fillColorEl.setState(style.bgcolor);
        this.alignEl.setState(style.align);
        this.valignEl.setState(style.valign);
        this.textwrapEl.setState(style.textwrap);
        // console.log('freeze is Active:', data.freezeIsActive());
        this.freezeEl.setState(data.freezeIsActive());
    }
}
exports.default = Toolbar;
//# sourceMappingURL=index.js.map