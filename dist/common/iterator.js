"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const util_1 = require("util");
class Iterator {
    constructor(next) {
        this.next = next;
    }
    noRace() {
        let pending;
        return new Iterator(() => {
            return pending = Promise.resolve(pending).then(() => this.next());
        });
    }
    keepWhile(cond) {
        let value;
        return new Iterator(async () => {
            while (value === undefined || !await cond(value))
                value = await this.next();
            return value;
        });
    }
    throttle(delay) {
        let lastTime = 0;
        return new Iterator(async () => {
            const elapsed = Date.now() - lastTime;
            const remaining = delay - elapsed;
            if (remaining > 0)
                await (0, util_1.promisify)(setTimeout)(remaining);
            const value = await this.next();
            lastTime = Date.now();
            return value;
        });
    }
}
exports.default = Iterator;
