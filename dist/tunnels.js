"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTunnel = createTunnel;
exports.destroyTunnel = destroyTunnel;
const child_process_1 = require("child_process");
const logger_1 = __importDefault(require("./common/logger"));
const tunnels = new Map();
function createTunnel(hostName, fromPort, toHost, toPort) {
    const key = `${hostName}:${fromPort}`;
    if (tunnels.has(key)) {
        logger_1.default.warn("Can't create, tunnel exists");
    }
    else {
        const tunnelArgs = fromPort < 0 ? ["-R", `${-fromPort}:${toHost}:${toPort}`] : ["-L", `${fromPort}:${toHost}:${toPort}`];
        const child = (0, child_process_1.spawn)("ssh", ["-N", "-o", "BatchMode=yes", ...tunnelArgs]);
        child.on("error", err => logger_1.default.error("Tunnel", child.pid, err));
        child.once("close", () => logger_1.default.info("Tunnel", child.pid, "terminated"));
        tunnels.set(key, child);
    }
}
function destroyTunnel(hostName, fromPort) {
    const key = `${hostName}:${fromPort}`;
    const child = tunnels.get(key);
    if (child) {
        logger_1.default.info("Tunnel", child.pid, "kill");
        child.kill();
        tunnels.delete(key);
    }
    else {
        logger_1.default.warn("Can't destroy, tunnel not exists");
    }
}
