"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cell_range_1 = require("./cell_range");
class Selector {
    constructor() {
        this.range = new cell_range_1.CellRange(0, 0, 0, 0);
        this.ri = 0;
        this.ci = 0;
    }
    multiple() {
        return this.range.multiple();
    }
    setIndexes(ri, ci) {
        this.ri = ri;
        this.ci = ci;
    }
    size() {
        return this.range.size();
    }
}
exports.default = Selector;
//# sourceMappingURL=selector.js.map