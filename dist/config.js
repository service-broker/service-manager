"use strict";
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv = require("dotenv");
const assert = require("assert");
dotenv.config();
assert(process.env.SERVICE_BROKER_URL, "Missing env SERVICE_BROKER_URL");
assert(process.env.PASSWORD, "Missing env PASSWORD");
exports.default = {
    password: process.env.PASSWORD,
    saveStateInterval: 30 * 1000,
    clientsKeepAliveInterval: 30 * 1000,
    commands: {
        unix: {
            listServices: "ls ${deployFolder}",
            readServiceConf: "cat ${deployFolder}/${serviceName}/.env",
            deployService: "cd ${deployFolder} && git clone ${repoUrl} ${serviceName} && cd ${serviceName} && npm i --only=prod --no-save",
            undeployService: "rm -rf ${deployFolder}/${serviceName}",
            startService: "cd ${deployFolder}/${serviceName} && " + ((_a = process.env.START_COMMAND) !== null && _a !== void 0 ? _a : "npm start") + " 1>stdout.log 2>stderr.log",
            killService: "kill -9 ${pid}",
            checkService: "timeout ${timeout} tail -f --pid=${pid} /dev/null; kill -0 ${pid}",
            updateService: "cd ${deployFolder}/${serviceName} && git fetch origin master && git reset --hard origin/master && npm i --only=prod --no-save",
            viewServiceLogs: "cd ${deployFolder}/${serviceName} && touch stdout.log stderr.log && tail -n ${lines} stdout.log && tail -n ${lines} stderr.log 1>&2",
        },
        windows: {
            listServices: "dir /B ${deployFolder}",
            readServiceConf: "type ${deployFolder}\\${serviceName}\\.env",
            deployService: "cd ${deployFolder} && git clone ${repoUrl} ${serviceName} && cd ${serviceName} && npm i --only=prod --no-save",
            undeployService: "rmdir /S /Q ${deployFolder}\\${serviceName}",
            startService: "cd ${deployFolder}\\${serviceName} && " + ((_b = process.env.START_COMMAND) !== null && _b !== void 0 ? _b : "npm start") + " 1>stdout.log 2>stderr.log",
            killService: "taskkill /F /PID ${pid}",
            checkService: "powershell Wait-Process -Id ${pid} -Timeout ${timeout}; Get-Process -Id ${pid}",
            updateService: "cd ${deployFolder}\\${serviceName} && git fetch origin master && git reset --hard origin/master && npm i --only=prod --no-save",
            viewServiceLogs: "cd ${deployFolder}\\${serviceName} && (if not exist stdout.log copy NUL stdout.log) && (if not exist stderr.log copy NUL stderr.log) && powershell Get-Content -Tail ${lines} stdout.log && powershell Get-Content -Tail ${lines} stderr.log 1>&2",
        }
    },
    // service broker info
    serviceBrokerUrl: process.env.SERVICE_BROKER_URL,
    // service deployment info
    siteName: process.env.SITE_NAME,
    serviceName: process.env.SERVICE_NAME,
    // the service provided by this module
    service: {
        name: "service-manager",
        priority: 100
    }
};
