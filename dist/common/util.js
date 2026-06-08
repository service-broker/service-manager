import { execFile } from "child_process";
import { promisify } from "util";
export function ssh(hostName, command) {
    return promisify(execFile)("ssh", ["-o", "BatchMode=yes", hostName, command]);
}
export function scp(from, to) {
    return promisify(execFile)("scp", ["-o", "BatchMode=yes", from, to]);
}
export function interpolate(template, vars) {
    for (const name in vars)
        template = template.split("${" + name + "}").join(vars[name]);
    return template;
}
