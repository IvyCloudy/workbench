"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/* global window */
const element_1 = require("./element");
const event_1 = require("./event");
const tooltip_1 = __importDefault(require("./tooltip"));
const dropdown_font_1 = __importDefault(require("./dropdown_font"));
const dropdown_fontsize_1 = __importDefault(require("./dropdown_fontsize"));
const dropdown_format_1 = __importDefault(require("./dropdown_format"));
const dropdown_formula_1 = __importDefault(require("./dropdown_formula"));
const dropdown_color_1 = __importDefault(require("./dropdown_color"));
const dropdown_align_1 = __importDefault(require("./dropdown_align"));
const dropdown_border_1 = __importDefault(require("./dropdown_border"));
const dropdown_1 = __importDefault(require("./dropdown"));
const icon_1 = __importDefault(require("./icon"));
const config_1 = require("../config");
const locale_1 = require("../locale/locale");
function buildIcon(name) {
    return new icon_1.default(name);
}
function buildButton(tooltipdata) {
    return (0, element_1.h)('div', `${config_1.cssPrefix}-toolbar-btn`)
        .on('mouseenter', (evt) => {
        (0, tooltip_1.default)(tooltipdata, evt.target);
    })
        .attr('data-tooltip', tooltipdata);
}
function buildDivider() {
    return (0, element_1.h)('div', `${config_1.cssPrefix}-toolbar-divider`);
}
function buildButtonWithIcon(tooltipdata, iconName, change = () => { }) {
    return buildButton(tooltipdata)
        .child(buildIcon(iconName))
        .on('click', () => change());
}
function bindDropdownChange() {
    this.ddFormat.change = it => this.change('format', it.key);
    this.ddFont.change = it => this.change('font-name', it.key);
    this.ddFormula.change = it => this.change('formula', it.key);
    this.ddFontSize.change = it => this.change('font-size', it.pt);
    this.ddTextColor.change = it => this.change('color', it);
    this.ddFillColor.change = it => this.change('bgcolor', it);
    this.ddAlign.change = it => this.change('align', it);
    this.ddVAlign.change = it => this.change('valign', it);
    this.ddBorder.change = it => this.change('border', it);
}
function toggleChange(type) {
    let elName = type;
    const types = type.split('-');
    if (types.length > 1) {
        types.forEach((it, i) => {
            if (i === 0)
                elName = it;
            else
                elName += it[0].toUpperCase() + it.substring(1);
        });
    }
    const el = this[`${elName}El`];
    el.toggle();
    this.change(type, el.hasClass('active'));
}
class DropdownMore extends dropdown_1.default {
    constructor() {
        const icon = new icon_1.default('ellipsis');
        const moreBtns = (0, element_1.h)('div', `${config_1.cssPrefix}-toolbar-more`);
        super(icon, 'auto', false, 'bottom-right', moreBtns);
        this.moreBtns = moreBtns;
        this.contentEl.css('max-width', '420px');
    }
}
function initBtns2() {
    this.btns2 = this.btnChildren.map((it) => {
        const rect = it.box();
        const { marginLeft, marginRight } = it.computedStyle();
        return [it, rect.width + parseInt(marginLeft, 10) + parseInt(marginRight, 10)];
    });
}
function moreResize() {
    const { el, btns, moreEl, ddMore, btns2, } = this;
    const { moreBtns, contentEl } = ddMore;
    el.css('width', `${this.widthFn() - 60}px`);
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
class Toolbar {
    constructor(data, widthFn, isHide = false) {
        this.data = data;
        this.change = () => { };
        this.widthFn = widthFn;
        const style = data.defaultStyle();
        // console.log('data:', data);
        this.ddFormat = new dropdown_format_1.default();
        this.ddFont = new dropdown_font_1.default();
        this.ddFormula = new dropdown_formula_1.default();
        this.ddFontSize = new dropdown_fontsize_1.default();
        this.ddTextColor = new dropdown_color_1.default('text-color', style.color);
        this.ddFillColor = new dropdown_color_1.default('fill-color', style.bgcolor);
        this.ddAlign = new dropdown_align_1.default(['left', 'center', 'right'], style.align);
        this.ddVAlign = new dropdown_align_1.default(['top', 'middle', 'bottom'], style.valign);
        this.ddBorder = new dropdown_border_1.default();
        this.ddMore = new DropdownMore();
        this.btnChildren = [
            this.undoEl = buildButtonWithIcon(`${(0, locale_1.t)('toolbar.undo')} (Ctrl+Z)`, 'undo', () => this.change('undo')),
            this.redoEl = buildButtonWithIcon(`${(0, locale_1.t)('toolbar.undo')} (Ctrl+Y)`, 'redo', () => this.change('redo')),
            // this.printEl = buildButtonWithIcon('Print (Ctrl+P)', 'print', () => this.change('print')),
            this.paintformatEl = buildButtonWithIcon(`${(0, locale_1.t)('toolbar.paintformat')}`, 'paintformat', () => toggleChange.call(this, 'paintformat')),
            this.clearformatEl = buildButtonWithIcon(`${(0, locale_1.t)('toolbar.clearformat')}`, 'clearformat', () => this.change('clearformat')),
            buildDivider(),
            buildButton(`${(0, locale_1.t)('toolbar.format')}`).child(this.ddFormat.el),
            buildDivider(),
            buildButton(`${(0, locale_1.t)('toolbar.font')}`).child(this.ddFont.el),
            buildButton(`${(0, locale_1.t)('toolbar.fontSize')}`).child(this.ddFontSize.el),
            buildDivider(),
            this.fontBoldEl = buildButtonWithIcon(`${(0, locale_1.t)('toolbar.fontBold')} (Ctrl+B)`, 'bold', () => toggleChange.call(this, 'font-bold')),
            this.fontItalicEl = buildButtonWithIcon(`${(0, locale_1.t)('toolbar.fontItalic')} (Ctrl+I)`, 'italic', () => toggleChange.call(this, 'font-italic')),
            this.underlineEl = buildButtonWithIcon(`${(0, locale_1.t)('toolbar.underline')} (Ctrl+U)`, 'underline', () => toggleChange.call(this, 'underline')),
            this.strikeEl = buildButtonWithIcon(`${(0, locale_1.t)('toolbar.strike')}`, 'strike', () => toggleChange.call(this, 'strike')),
            buildButton(`${(0, locale_1.t)('toolbar.textColor')}`).child(this.ddTextColor.el),
            buildDivider(),
            buildButton(`${(0, locale_1.t)('toolbar.fillColor')}`).child(this.ddFillColor.el),
            buildButton(`${(0, locale_1.t)('toolbar.border')}`).child(this.ddBorder.el),
            this.mergeEl = buildButtonWithIcon(`${(0, locale_1.t)('toolbar.merge')}`, 'merge', () => toggleChange.call(this, 'merge')),
            buildDivider(),
            buildButton(`${(0, locale_1.t)('toolbar.align')}`).child(this.ddAlign.el),
            buildButton(`${(0, locale_1.t)('toolbar.valign')}`).child(this.ddVAlign.el),
            this.textwrapEl = buildButtonWithIcon(`${(0, locale_1.t)('toolbar.textwrap')}`, 'textwrap', () => toggleChange.call(this, 'textwrap')),
            buildDivider(),
            // this.linkEl = buildButtonWithIcon('Insert link', 'link'),
            // this.chartEl = buildButtonWithIcon('Insert chart', 'chart'),
            this.freezeEl = buildButtonWithIcon(`${(0, locale_1.t)('toolbar.freeze')}`, 'freeze', () => toggleChange.call(this, 'freeze')),
            this.autofilterEl = buildButtonWithIcon(`${(0, locale_1.t)('toolbar.autofilter')}`, 'autofilter', () => toggleChange.call(this, 'autofilter')),
            buildButton(`${(0, locale_1.t)('toolbar.formula')}`).child(this.ddFormula.el),
            // buildDivider(),
            this.moreEl = buildButton(`${(0, locale_1.t)('toolbar.more')}`).child(this.ddMore.el).hide(),
        ];
        this.el = (0, element_1.h)('div', `${config_1.cssPrefix}-toolbar`);
        this.btns = (0, element_1.h)('div', `${config_1.cssPrefix}-toolbar-btns`).children(...this.btnChildren);
        this.el.child(this.btns);
        if (isHide)
            this.el.hide();
        bindDropdownChange.call(this);
        this.reset();
        setTimeout(() => {
            initBtns2.call(this);
            moreResize.call(this);
        }, 0);
        (0, event_1.bind)(window, 'resize', () => {
            moreResize.call(this);
        });
    }
    paintformatActive() {
        return this.paintformatEl.hasClass('active');
    }
    paintformatToggle() {
        this.paintformatEl.toggle();
    }
    trigger(type) {
        toggleChange.call(this, type);
    }
    reset() {
        const { data } = this;
        const style = data.getSelectedCellStyle();
        const cell = data.getSelectedCell();
        // console.log('canUndo:', data.canUndo());
        this.undoEl.disabled(!data.canUndo());
        this.redoEl.disabled(!data.canRedo());
        this.mergeEl.active(data.canUnmerge())
            .disabled(!data.selector.multiple());
        this.autofilterEl.active(!data.canAutofilter());
        // this.mergeEl.disabled();
        // console.log('selectedCell:', style, cell);
        const { font } = style;
        this.ddFont.setTitle(font.name);
        this.ddFontSize.setTitle(font.size);
        this.fontBoldEl.active(font.bold);
        this.fontItalicEl.active(font.italic);
        this.underlineEl.active(style.underline);
        this.strikeEl.active(style.strike);
        this.ddTextColor.setTitle(style.color);
        this.ddFillColor.setTitle(style.bgcolor);
        this.ddAlign.setTitle(style.align);
        this.ddVAlign.setTitle(style.valign);
        this.textwrapEl.active(style.textwrap);
        // console.log('freeze is Active:', data.freezeIsActive());
        this.freezeEl.active(data.freezeIsActive());
        if (cell) {
            if (cell.format) {
                this.ddFormat.setTitle(cell.format);
            }
        }
    }
}
exports.default = Toolbar;
//# sourceMappingURL=toolbar.js.map