"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.spreadsheet = exports.Spreadsheet = void 0;
/* global window, document */
const element_1 = require("./component/element");
const data_proxy_1 = __importDefault(require("./core/data_proxy"));
const sheet_1 = __importDefault(require("./component/sheet"));
const bottombar_1 = __importDefault(require("./component/bottombar"));
const config_1 = require("./config");
const locale_1 = require("./locale/locale");
require("./index.less");
class Spreadsheet {
    constructor(selectors, options = {}) {
        let targetEl = selectors;
        this.options = { showBottomBar: true, ...options };
        this.sheetIndex = 1;
        this.datas = [];
        if (typeof selectors === 'string') {
            targetEl = document.querySelector(selectors);
        }
        this.bottombar = this.options.showBottomBar ? new bottombar_1.default(() => {
            if (this.options.mode === 'read')
                return;
            const d = this.addSheet();
            this.sheet.resetData(d);
        }, (index) => {
            const d = this.datas[index];
            this.sheet.resetData(d);
        }, () => {
            this.deleteSheet();
        }, (index, value) => {
            this.datas[index].name = value;
            this.sheet.trigger('change');
        }) : null;
        this.data = this.addSheet();
        const rootEl = (0, element_1.h)('div', `${config_1.cssPrefix}`)
            .on('contextmenu', (evt) => evt.preventDefault());
        targetEl.appendChild(rootEl.el);
        this.sheet = new sheet_1.default(rootEl, this.data);
        if (this.bottombar !== null) {
            rootEl.child(this.bottombar.el);
        }
    }
    addSheet(name, active = true) {
        const n = name || `sheet${this.sheetIndex}`;
        const d = new data_proxy_1.default(n, this.options);
        d.change = (...args) => {
            this.sheet.trigger('change', ...args);
        };
        this.datas.push(d);
        if (this.bottombar !== null) {
            this.bottombar.addItem(n, active, this.options);
        }
        this.sheetIndex += 1;
        return d;
    }
    deleteSheet() {
        if (this.bottombar === null)
            return;
        const [oldIndex, nindex] = this.bottombar.deleteItem();
        if (oldIndex >= 0) {
            this.datas.splice(oldIndex, 1);
            if (nindex >= 0)
                this.sheet.resetData(this.datas[nindex]);
            this.sheet.trigger('change');
        }
    }
    loadData(data) {
        const ds = Array.isArray(data) ? data : [data];
        if (this.bottombar !== null) {
            this.bottombar.clear();
        }
        this.datas = [];
        if (ds.length > 0) {
            for (let i = 0; i < ds.length; i += 1) {
                const it = ds[i];
                const nd = this.addSheet(it.name, i === 0);
                nd.setData(it);
                if (i === 0) {
                    this.sheet.resetData(nd);
                }
            }
        }
        return this;
    }
    getData() {
        return this.datas.map(it => it.getData());
    }
    cellText(ri, ci, text, sheetIndex = 0) {
        this.datas[sheetIndex].setCellText(ri, ci, text, 'finished');
        return this;
    }
    cell(ri, ci, sheetIndex = 0) {
        return this.datas[sheetIndex].getCell(ri, ci);
    }
    cellStyle(ri, ci, sheetIndex = 0) {
        return this.datas[sheetIndex].getCellStyle(ri, ci);
    }
    reRender() {
        this.sheet.table.render();
        return this;
    }
    on(eventName, func) {
        this.sheet.on(eventName, func);
        return this;
    }
    validate() {
        const { validations } = this.data;
        return validations.errors.size <= 0;
    }
    change(cb) {
        this.sheet.on('change', cb);
        return this;
    }
    static locale(lang, message) {
        (0, locale_1.locale)(lang, message);
    }
}
exports.Spreadsheet = Spreadsheet;
const spreadsheet = (el, options = {}) => new Spreadsheet(el, options);
exports.spreadsheet = spreadsheet;
if (window) {
    window.x_spreadsheet = spreadsheet;
    window.x_spreadsheet.locale = (lang, message) => (0, locale_1.locale)(lang, message);
}
exports.default = Spreadsheet;
//# sourceMappingURL=index.js.map