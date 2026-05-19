"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const element_1 = require("./element");
const button_1 = __importDefault(require("./button"));
const event_1 = require("./event");
const config_1 = require("../config");
const locale_1 = require("../locale/locale");
function buildMenu(clsName) {
    return (0, element_1.h)('div', `${config_1.cssPrefix}-item ${clsName}`);
}
function buildSortItem(it) {
    return buildMenu('state').child((0, locale_1.t)(`sort.${it}`))
        .on('click.stop', () => this.itemClick(it));
}
function buildFilterBody(items) {
    const { filterbEl, filterValues } = this;
    filterbEl.html('');
    const itemKeys = Object.keys(items);
    itemKeys.forEach((it, index) => {
        const cnt = items[it];
        const active = filterValues.includes(it) ? 'checked' : '';
        filterbEl.child((0, element_1.h)('div', `${config_1.cssPrefix}-item state ${active}`)
            .on('click.stop', () => this.filterClick(index, it))
            .children(it === '' ? (0, locale_1.t)('filter.empty') : it, (0, element_1.h)('div', 'label').html(`(${cnt})`)));
    });
}
function resetFilterHeader() {
    const { filterhEl, filterValues, values } = this;
    filterhEl.html(`${filterValues.length} / ${values.length}`);
    filterhEl.checked(filterValues.length === values.length);
}
class SortFilter {
    constructor() {
        this.filterbEl = (0, element_1.h)('div', `${config_1.cssPrefix}-body`);
        this.filterhEl = (0, element_1.h)('div', `${config_1.cssPrefix}-header state`).on('click.stop', () => this.filterClick(0, 'all'));
        this.el = (0, element_1.h)('div', `${config_1.cssPrefix}-sort-filter`).children(this.sortAscEl = buildSortItem.call(this, 'asc'), this.sortDescEl = buildSortItem.call(this, 'desc'), buildMenu('divider'), (0, element_1.h)('div', `${config_1.cssPrefix}-filter`).children(this.filterhEl, this.filterbEl), (0, element_1.h)('div', `${config_1.cssPrefix}-buttons`).children(new button_1.default('cancel').on('click', () => this.btnClick('cancel')), new button_1.default('ok', 'primary').on('click', () => this.btnClick('ok')))).hide();
        // this.setFilters(['test1', 'test2', 'text3']);
        this.ci = null;
        this.sortDesc = null;
        this.values = null;
        this.filterValues = [];
    }
    btnClick(it) {
        if (it === 'ok') {
            const { ci, sort, filterValues } = this;
            if (this.ok) {
                this.ok(ci, sort, 'in', filterValues);
            }
        }
        this.hide();
    }
    itemClick(it) {
        // console.log('it:', it);
        this.sort = it;
        const { sortAscEl, sortDescEl } = this;
        sortAscEl.checked(it === 'asc');
        sortDescEl.checked(it === 'desc');
    }
    filterClick(index, it) {
        // console.log('index:', index, it);
        const { filterbEl, filterValues, values } = this;
        const children = filterbEl.children();
        if (it === 'all') {
            if (children.length === filterValues.length) {
                this.filterValues = [];
                children.forEach(i => (0, element_1.h)(i).checked(false));
            }
            else {
                this.filterValues = Array.from(values);
                children.forEach(i => (0, element_1.h)(i).checked(true));
            }
        }
        else {
            const checked = (0, element_1.h)(children[index]).toggle('checked');
            if (checked) {
                filterValues.push(it);
            }
            else {
                filterValues.splice(filterValues.findIndex(i => i === it), 1);
            }
        }
        resetFilterHeader.call(this);
    }
    // v: autoFilter
    // items: {value: cnt}
    // sort { ci, order }
    set(ci, items, filter, sort) {
        this.ci = ci;
        const { sortAscEl, sortDescEl } = this;
        if (sort !== null) {
            this.sort = sort.order;
            sortAscEl.checked(sort.asc());
            sortDescEl.checked(sort.desc());
        }
        else {
            this.sortDesc = null;
            sortAscEl.checked(false);
            sortDescEl.checked(false);
        }
        // this.setFilters(items, filter);
        this.values = Object.keys(items);
        this.filterValues = filter ? Array.from(filter.value) : Object.keys(items);
        buildFilterBody.call(this, items, filter);
        resetFilterHeader.call(this);
    }
    setOffset(v) {
        this.el.offset(v).show();
        let tindex = 1;
        (0, event_1.bindClickoutside)(this.el, () => {
            if (tindex <= 0) {
                this.hide();
            }
            tindex -= 1;
        });
    }
    show() {
        this.el.show();
    }
    hide() {
        this.el.hide();
        (0, event_1.unbindClickoutside)(this.el);
    }
}
exports.default = SortFilter;
//# sourceMappingURL=sort_filter.js.map