import { execFile } from "child_process";
import { promisify } from "util";

export function ssh(hostName: string, command:string) {
  return promisify(execFile)("ssh", ["-o", "BatchMode=yes", hostName, command]);
}

export function scp(from: string, to: string) {
  return promisify(execFile)("scp", ["-o", "BatchMode=yes", from, to]);
}

export function interpolate(template: string, vars: {[key: string]: any}) {
  for (const name in vars) template = template.split("${" + name + "}").join(vars[name]);
  return template;
}
