"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTunnel = createTunnel;
exports.destroyTunnel = destroyTunnel;
const child_process_1 = require("child_process");
const rxjs = __importStar(require("rxjs"));
const logger_1 = __importDefault(require("./common/logger"));
const tunnels = new Map();
function createTunnel(hostName, fromPort, toHost, toPort) {
    const key = `${hostName}:${fromPort}`;
    if (tunnels.has(key)) {
        logger_1.default.warn("Can't create, tunnel exists");
    }
    else {
        tunnels.set(key, setup(hostName, fromPort, toHost, toPort));
    }
}
function destroyTunnel(hostName, fromPort) {
    const key = `${hostName}:${fromPort}`;
    const sub = tunnels.get(key);
    if (sub) {
        logger_1.default.info("Tunnel stop()", hostName, fromPort);
        sub.unsubscribe();
        tunnels.delete(key);
    }
    else {
        logger_1.default.warn("Can't destroy, tunnel not exists");
    }
}
function setup(hostName, fromPort, toHost, toPort) {
    const abortCtrl = new AbortController();
    return rxjs.defer(makeChild).pipe(rxjs.exhaustMap(child => rxjs.merge(rxjs.timer(10 * 1000), waitTerminate(child).then(() => { throw "recreate"; }))), rxjs.retry({
        delay: (err, retryCount) => rxjs.timer(retryCount <= 1 ? 1000 : 15 * 1000),
        resetOnSuccess: true
    }), rxjs.finalize(() => abortCtrl.abort())).subscribe();
    async function makeChild() {
        try {
            const child = (0, child_process_1.spawn)("ssh", [
                "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
                ...(fromPort < 0
                    ? ["-R", `${-fromPort}:${toHost}:${toPort}`]
                    : ["-L", `${fromPort}:${toHost}:${toPort}`]),
                hostName
            ], {
                signal: abortCtrl.signal
            });
            await new Promise((f, r) => child.once("spawn", f).once("error", r));
            logger_1.default.info("Tunnel STARTED", hostName, fromPort, child.pid);
            return child;
        }
        catch (err) {
            logger_1.default.error("Tunnel start()", hostName, fromPort, err);
            throw err;
        }
    }
    async function waitTerminate(child) {
        child.on("error", err => {
            if (err.name != "AbortError")
                logger_1.default.error("Tunnel ERROR", hostName, fromPort, child.pid, err);
        });
        const exitCode = await new Promise(fulfill => child.once("close", (code, signal) => fulfill(signal ?? code)));
        logger_1.default.info("Tunnel TERMINATED", hostName, fromPort, child.pid, exitCode);
    }
}
