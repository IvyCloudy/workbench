"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dropdown_1 = __importDefault(require("./dropdown"));
const element_1 = require("./element");
const icon_1 = __importDefault(require("./icon"));
const config_1 = require("../config");
const lineTypes = [
    ['thin', '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="1" style="user-select: none;"><line x1="0" y1="0.5" x2="50" y2="0.5" stroke-width="1" stroke="black" style="user-select: none;"></line></svg>'],
    ['medium', '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="2" style="user-select: none;"><line x1="0" y1="1.0" x2="50" y2="1.0" stroke-width="2" stroke="black" style="user-select: none;"></line></svg>'],
    ['thick', '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="3" style="user-select: none;"><line x1="0" y1="1.5" x2="50" y2="1.5" stroke-width="3" stroke="black" style="user-select: none;"></line></svg>'],
    ['dashed', '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="1" style="user-select: none;"><line x1="0" y1="0.5" x2="50" y2="0.5" stroke-width="1" stroke="black" stroke-dasharray="2" style="user-select: none;"></line></svg>'],
    ['dotted', '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="1" style="user-select: none;"><line x1="0" y1="0.5" x2="50" y2="0.5" stroke-width="1" stroke="black" stroke-dasharray="1" style="user-select: none;"></line></svg>'],
    // ['double', '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="3" style="user-select: none;"><line x1="0" y1="0.5" x2="50" y2="0.5" stroke-width="1" stroke="black" style="user-select: none;"></line><line x1="0" y1="2.5" x2="50" y2="2.5" stroke-width="1" stroke="black" style="user-select: none;"></line></svg>'],
];
class DropdownLineType extends dropdown_1.default {
    constructor(type) {
        const icon = new icon_1.default('line-type');
        let beforei = 0;
        const lineTypeEls = lineTypes.map((it, iti) => (0, element_1.h)('div', `${config_1.cssPrefix}-item state ${type === it[0] ? 'checked' : ''}`)
            .on('click', () => {
            lineTypeEls[beforei].toggle('checked');
            lineTypeEls[iti].toggle('checked');
            beforei = iti;
            this.hide();
            this.change(it);
        })
            .child((0, element_1.h)('div', `${config_1.cssPrefix}-line-type`).html(it[1])));
        super(icon, 'auto', false, 'bottom-left', ...lineTypeEls);
    }
}
exports.default = DropdownLineType;
//# sourceMappingURL=dropdown_linetype.js.map