"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const calendar_1 = __importDefault(require("./calendar"));
const element_1 = require("./element");
const config_1 = require("../config");
class Datepicker {
    constructor() {
        this.calendar = new calendar_1.default(new Date());
        this.el = (0, element_1.h)('div', `${config_1.cssPrefix}-datepicker`).child(this.calendar.el).hide();
    }
    setValue(date) {
        // console.log(':::::::', date, typeof date, date instanceof string);
        const { calendar } = this;
        if (typeof date === 'string') {
            // console.log(/^\d{4}-\d{1,2}-\d{1,2}$/.test(date));
            if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(date)) {
                calendar.setValue(new Date(date.replace(new RegExp('-', 'g'), '/')));
            }
        }
        else if (date instanceof Date) {
            calendar.setValue(date);
        }
        return this;
    }
    change(cb) {
        this.calendar.selectChange = (d) => {
            cb(d);
            this.hide();
        };
    }
    show() {
        this.el.show();
    }
    hide() {
        this.el.hide();
    }
}
exports.default = Datepicker;
//# sourceMappingURL=datepicker.js.map