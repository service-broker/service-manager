"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ssh = ssh;
exports.scp = scp;
exports.interpolate = interpolate;
const child_process_1 = require("child_process");
const util_1 = require("util");
function ssh(hostName, command) {
    return (0, util_1.promisify)(child_process_1.execFile)("ssh", ["-o", "BatchMode=yes", hostName, command]);
}
function scp(from, to) {
    return (0, util_1.promisify)(child_process_1.execFile)("scp", ["-o", "BatchMode=yes", from, to]);
}
function interpolate(template, vars) {
    for (const name in vars)
        template = template.split("${" + name + "}").join(vars[name]);
    return template;
}
