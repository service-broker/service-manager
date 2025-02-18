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
const assert_1 = __importDefault(require("assert"));
const dotenv_1 = __importDefault(require("dotenv"));
const fs_1 = __importDefault(require("fs"));
const rxjs = __importStar(require("rxjs"));
const tmp_1 = require("tmp");
const util_1 = require("util");
const logger_1 = __importDefault(require("./common/logger"));
const service_broker_1 = __importDefault(require("./common/service-broker"));
const service_manager_1 = require("./common/service-manager");
const util_2 = require("./common/util");
const config_1 = __importDefault(require("./config"));
const tunnels_1 = require("./tunnels");
var ServiceStatus;
(function (ServiceStatus) {
    ServiceStatus["STOPPED"] = "STOPPED";
    ServiceStatus["STOPPING"] = "STOPPING";
    ServiceStatus["STARTED"] = "STARTED";
    ServiceStatus["STARTING"] = "STARTING";
})(ServiceStatus || (ServiceStatus = {}));
const clients = {};
const state = loadState();
const stateChange$ = new rxjs.Subject();
const topicHistory = {};
for (const topic of Object.values(state.topics)) {
    service_broker_1.default.subscribe(topic.topicName, (text) => onTopicMessage(topic, text));
}
const jobs = [
    rxjs.interval(config_1.default.clientsKeepAliveInterval).subscribe(clientsKeepAlive),
    stateChange$.subscribe(broadcastStateUpdate),
    stateChange$.pipe(rxjs.auditTime(1000)).subscribe(saveState),
];
(0, service_manager_1.addShutdownHandler)(() => {
    for (const job of jobs)
        job.unsubscribe();
});
function loadState() {
    try {
        const text = fs_1.default.readFileSync("state.json", "utf8");
        const state = JSON.parse(text);
        for (const siteName in state.sites) {
            const site = state.sites[siteName];
            if (!site.tunnels)
                site.tunnels = {};
            for (const fromPort in site.tunnels) {
                const { toHost, toPort } = site.tunnels[fromPort];
                (0, tunnels_1.createTunnel)(site.hostName, Number(fromPort), toHost, toPort);
            }
        }
        return state;
    }
    catch (err) {
        return { sites: {}, topics: {} };
    }
}
function saveState() {
    fs_1.default.writeFile("state.json", JSON.stringify(state), err => err && console.error(err));
}
service_broker_1.default.advertise(config_1.default.service, onRequest)
    .then(() => logger_1.default.info(config_1.default.service.name + " service started"));
function onRequest(req) {
    const method = req.header.method;
    const args = req.header.args || {};
    if (method == "clientLogin")
        return clientLogin(args.password, req.header.from);
    else if (method == "serviceCheckIn")
        return serviceCheckIn(args.siteName, args.serviceName, args.pid, req.header.from);
    const client = clients[req.header.from];
    if (!client)
        throw new Error("Unauthorized");
    else if (method == "addSite")
        return addSite(args.siteName, args.hostName, args.deployFolder, args.serviceBrokerUrl);
    else if (method == "removeSite")
        return removeSite(args.siteName);
    else if (method == "deployService")
        return deployService(args.siteName, args.serviceName, args.repoUrl, args.repoTag);
    else if (method == "undeployService")
        return undeployService(args.siteName, args.serviceName);
    else if (method == "startService")
        return startService(args.siteName, args.serviceName);
    else if (method == "stopService")
        return stopService(args.siteName, args.serviceName);
    else if (method == "killService")
        return killService(args.siteName, args.serviceName);
    else if (method == "viewServiceLogs")
        return viewServiceLogs(args.siteName, args.serviceName, args.lines);
    else if (method == "setServiceStatus")
        return setServiceStatus(args.siteName, args.serviceName, args.newStatus);
    else if (method == "updateService")
        return updateService(args.siteName, args.serviceName);
    else if (method == "getServiceConf")
        return getServiceConf(args.siteName, args.serviceName);
    else if (method == "updateServiceConf")
        return updateServiceConf(args.siteName, args.serviceName, args.serviceConf);
    else if (method == "addTopic")
        return addTopic(args.topicName, args.historySize);
    else if (method == "removeTopic")
        return removeTopic(args.topicName);
    else if (method == "subscribeTopic")
        return subscribeTopic(client, args.topicName);
    else if (method == "unsubscribeTopic")
        return unsubscribeTopic(client);
    else if (method == "addTunnel")
        return addTunnel(args.siteName, args.fromPort, args.toHost, args.toPort);
    else if (method == "removeTunnel")
        return removeTunnel(args.siteName, args.fromPort);
    else
        throw new Error("Unknown method " + method);
}
function clientLogin(password, endpointId) {
    if (password != config_1.default.password)
        throw new Error("Wrong password");
    if (clients[endpointId])
        throw new Error("Already logged in");
    logger_1.default.info("Client connected", endpointId);
    clients[endpointId] = { endpointId };
    return {
        header: { serverTime: Date.now() },
        payload: JSON.stringify(state)
    };
}
function broadcastStateUpdate(patch) {
    Object.values(clients).forEach(client => {
        service_broker_1.default.notifyTo(client.endpointId, "service-manager-client", {
            header: { method: "onStateUpdate" },
            payload: JSON.stringify([patch])
        });
    });
}
function clientsKeepAlive() {
    for (const client of Object.values(clients)) {
        service_broker_1.default.requestTo(client.endpointId, "service-manager-client", { header: { method: "ping" } })
            .catch(err => onClientError(client, err));
    }
}
function onClientError(client, err) {
    logger_1.default.info("Client disconnected", client.endpointId, JSON.stringify(err.message));
    delete clients[client.endpointId];
}
async function addSite(siteName, hostName, deployFolder, serviceBrokerUrl) {
    (0, assert_1.default)(siteName && hostName && deployFolder && serviceBrokerUrl, "Missing args");
    (0, assert_1.default)(!state.sites[siteName], "Site already exists");
    if (deployFolder.startsWith("~/"))
        deployFolder = deployFolder.slice(2);
    if (deployFolder.endsWith("/"))
        deployFolder = deployFolder.slice(0, -1);
    const operatingSystem = await getOperatingSystem(hostName);
    const site = {
        siteName,
        hostName,
        operatingSystem,
        deployFolder,
        serviceBrokerUrl,
        services: {},
        tunnels: {},
    };
    site.services = await getDeployedServices(site);
    state.sites[siteName] = site;
    stateChange$.next({ op: "add", path: `/sites/${siteName}`, value: site });
}
async function getOperatingSystem(hostName) {
    try {
        await (0, util_2.ssh)(hostName, "ls");
        return "unix";
    }
    catch (err) {
        return "windows";
    }
}
async function getDeployedServices(site) {
    const commands = config_1.default.commands[site.operatingSystem];
    let output = await (0, util_2.ssh)(site.hostName, (0, util_2.interpolate)(commands.listServices, { deployFolder: site.deployFolder }));
    output.stdout = output.stdout.trim();
    const serviceNames = output.stdout ? output.stdout.split(/\s+/) : [];
    const services = {};
    for (const serviceName of serviceNames) {
        const envInfo = await readServiceConf(site, serviceName);
        (0, assert_1.default)(envInfo.REPO_URL, "Missing env REPO_URL for service " + serviceName);
        services[serviceName] = {
            serviceName,
            repoUrl: envInfo.REPO_URL,
            repoTag: envInfo.REPO_TAG,
            status: ServiceStatus.STOPPED
        };
        if (envInfo.SITE_NAME != site.siteName) {
            envInfo.SITE_NAME = site.siteName;
            await writeServiceConf(site, serviceName, envInfo);
        }
    }
    return services;
}
function removeSite(siteName) {
    (0, assert_1.default)(siteName, "Missing args");
    (0, assert_1.default)(state.sites[siteName], "Site not found");
    (0, assert_1.default)(!isSiteActive(state.sites[siteName]), "Site active");
    delete state.sites[siteName];
    stateChange$.next({ op: "remove", path: `/sites/${siteName}` });
}
function isSiteActive(site) {
    return Object.values(site.services).some(x => x.status != ServiceStatus.STOPPED)
        || Object.values(site.tunnels).length > 0;
}
async function deployService(siteName, serviceName, repoUrl, repoTag) {
    (0, assert_1.default)(siteName && serviceName && repoUrl, "Missing args");
    const site = state.sites[siteName];
    (0, assert_1.default)(site, "Site not found");
    (0, assert_1.default)(!site.services[serviceName], "Service exists");
    const commands = config_1.default.commands[site.operatingSystem];
    let output = await (0, util_2.ssh)(site.hostName, (0, util_2.interpolate)(commands.deployService, {
        deployFolder: site.deployFolder,
        serviceName,
        repoUrl,
        repoTag: repoTag || "master"
    }));
    await writeServiceConf(site, serviceName, {
        REPO_URL: repoUrl,
        REPO_TAG: repoTag,
        SERVICE_BROKER_URL: site.serviceBrokerUrl,
        SITE_NAME: siteName,
        SERVICE_NAME: serviceName,
    });
    site.services[serviceName] = {
        serviceName,
        repoUrl,
        repoTag,
        status: ServiceStatus.STOPPED
    };
    stateChange$.next({ op: "add", path: `/sites/${siteName}/services/${serviceName}`, value: site.services[serviceName] });
    return { payload: JSON.stringify(output) };
}
async function readServiceConf(site, serviceName) {
    const commands = config_1.default.commands[site.operatingSystem];
    const output = await (0, util_2.ssh)(site.hostName, (0, util_2.interpolate)(commands.readServiceConf, { deployFolder: site.deployFolder, serviceName }));
    return dotenv_1.default.parse(output.stdout);
}
async function writeServiceConf(site, serviceName, props) {
    const file = await new Promise((fulfill, reject) => (0, tmp_1.tmpName)((err, path) => err ? reject(err) : fulfill(path)));
    const text = Object.keys(props)
        .filter(name => props[name] != undefined)
        .map(name => `${name}=${props[name]}`)
        .join('\n');
    await (0, util_1.promisify)(fs_1.default.writeFile)(file, text);
    await (0, util_2.scp)(file, `${site.hostName}:${site.deployFolder}/${serviceName}/.env`);
    await (0, util_1.promisify)(fs_1.default.unlink)(file);
}
async function undeployService(siteName, serviceName) {
    (0, assert_1.default)(siteName && serviceName, "Missing args");
    const site = state.sites[siteName];
    (0, assert_1.default)(site, "Site not found");
    const service = site.services[serviceName];
    (0, assert_1.default)(service, "Service not exists");
    (0, assert_1.default)(service.status == ServiceStatus.STOPPED, "Service not stopped");
    const commands = config_1.default.commands[site.operatingSystem];
    await (0, util_2.ssh)(site.hostName, (0, util_2.interpolate)(commands.undeployService, { deployFolder: site.deployFolder, serviceName }));
    delete site.services[serviceName];
    stateChange$.next({ op: "remove", path: `/sites/${siteName}/services/${serviceName}` });
}
async function startService(siteName, serviceName) {
    (0, assert_1.default)(siteName && serviceName, "Missing args");
    const site = state.sites[siteName];
    (0, assert_1.default)(site, "Site not found");
    const service = site.services[serviceName];
    (0, assert_1.default)(service, "Service not exists");
    (0, assert_1.default)(service.status == ServiceStatus.STOPPED, "Service not stopped");
    const commands = config_1.default.commands[site.operatingSystem];
    (0, util_2.ssh)(site.hostName, (0, util_2.interpolate)(commands.startService, { deployFolder: site.deployFolder, serviceName }))
        .catch(err => "OK")
        .then(() => setStopped(site, service));
    service.status = ServiceStatus.STARTING;
    stateChange$.next({ op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status });
}
function setStopped(site, service) {
    if (service.status == ServiceStatus.STOPPED)
        return;
    service.status = ServiceStatus.STOPPED;
    service.pid = undefined;
    service.endpointId = undefined;
    service.lastCheckedIn = undefined;
    stateChange$.next({ op: "replace", path: `/sites/${site.siteName}/services/${service.serviceName}`, value: service });
}
async function stopService(siteName, serviceName) {
    (0, assert_1.default)(siteName && serviceName, "Missing args");
    const site = state.sites[siteName];
    (0, assert_1.default)(site, "Site not found");
    const service = site.services[serviceName];
    (0, assert_1.default)(service, "Service not exists");
    (0, assert_1.default)(service.status == ServiceStatus.STARTED, "Service not started");
    (0, assert_1.default)(service.endpointId, "FATAL endpointId null");
    await service_broker_1.default.requestTo(service.endpointId, "service-manager-client", { header: { method: "shutdown", pid: service.pid } });
    service.status = ServiceStatus.STOPPING;
    stateChange$.next({ op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status });
    waitUntilStopped(site, service, 6);
}
async function waitUntilStopped(site, service, timeout) {
    try {
        const commands = config_1.default.commands[site.operatingSystem];
        await (0, util_2.ssh)(site.hostName, (0, util_2.interpolate)(commands.checkService, { pid: service.pid, timeout }));
    }
    catch (err) {
        setStopped(site, service);
    }
}
async function killService(siteName, serviceName) {
    (0, assert_1.default)(siteName && serviceName, "Missing args");
    const site = state.sites[siteName];
    (0, assert_1.default)(site, "Site not found");
    const service = site.services[serviceName];
    (0, assert_1.default)(service, "Service not exists");
    (0, assert_1.default)(service.status == ServiceStatus.STARTED || service.status == ServiceStatus.STOPPING, "Service not started or stopping");
    const commands = config_1.default.commands[site.operatingSystem];
    await (0, util_2.ssh)(site.hostName, (0, util_2.interpolate)(commands.killService, { pid: service.pid }));
    if (service.status != ServiceStatus.STOPPING) {
        service.status = ServiceStatus.STOPPING;
        stateChange$.next({ op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status });
    }
    waitUntilStopped(site, service, 3);
}
async function viewServiceLogs(siteName, serviceName, lines) {
    (0, assert_1.default)(siteName && serviceName && lines, "Missing args");
    const site = state.sites[siteName];
    (0, assert_1.default)(site, "Site not found");
    const service = site.services[serviceName];
    (0, assert_1.default)(service, "Service not exists");
    const commands = config_1.default.commands[site.operatingSystem];
    let output = await (0, util_2.ssh)(site.hostName, (0, util_2.interpolate)(commands.viewServiceLogs, { deployFolder: site.deployFolder, serviceName, lines }));
    return { payload: JSON.stringify(output) };
}
function setServiceStatus(siteName, serviceName, newStatus) {
    (0, assert_1.default)(siteName && serviceName && newStatus, "Missing args");
    const site = state.sites[siteName];
    (0, assert_1.default)(site, "Site not found");
    const service = site.services[serviceName];
    (0, assert_1.default)(service, "Service not exists");
    if (service.status != newStatus) {
        service.status = newStatus;
        stateChange$.next({ op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status });
    }
}
async function updateService(siteName, serviceName) {
    (0, assert_1.default)(siteName && serviceName, "Missing args");
    const site = state.sites[siteName];
    (0, assert_1.default)(site, "Site not found");
    const service = site.services[serviceName];
    (0, assert_1.default)(service, "Service not exists");
    const commands = config_1.default.commands[site.operatingSystem];
    let output = await (0, util_2.ssh)(site.hostName, (0, util_2.interpolate)(commands.updateService, {
        deployFolder: site.deployFolder,
        serviceName,
        repoTag: service.repoTag || "master"
    }));
    return { payload: JSON.stringify(output) };
}
async function getServiceConf(siteName, serviceName) {
    (0, assert_1.default)(siteName && serviceName, "Missing args");
    const site = state.sites[siteName];
    (0, assert_1.default)(site, "Site not found");
    const props = await readServiceConf(site, serviceName);
    return { header: { serviceConf: props } };
}
async function updateServiceConf(siteName, serviceName, serviceConf) {
    (0, assert_1.default)(siteName && serviceName, "Missing args");
    const site = state.sites[siteName];
    (0, assert_1.default)(site, "Site not found");
    await writeServiceConf(site, serviceName, serviceConf);
}
function serviceCheckIn(siteName, serviceName, pid, endpointId) {
    (0, assert_1.default)(siteName && serviceName && pid && endpointId, "Missing args");
    const site = state.sites[siteName];
    (0, assert_1.default)(site, "Site not found");
    const service = site.services[serviceName];
    (0, assert_1.default)(service, "Service not exists");
    if (service.status == ServiceStatus.STARTED && service.pid == pid && service.endpointId == endpointId) {
        service.lastCheckedIn = Date.now();
    }
    else {
        service.status = ServiceStatus.STARTED;
        service.pid = pid;
        service.endpointId = endpointId;
        service.lastCheckedIn = Date.now();
        stateChange$.next({ op: "replace", path: `/sites/${siteName}/services/${serviceName}`, value: service });
    }
}
async function addTopic(topicName, historySize) {
    (0, assert_1.default)(topicName && historySize, "Missing args");
    (0, assert_1.default)(!state.topics[topicName], "Topic already exists");
    const topic = { topicName, historySize };
    await service_broker_1.default.subscribe(topic.topicName, (text) => onTopicMessage(topic, text));
    state.topics[topicName] = topic;
    stateChange$.next({ op: "add", path: `/topics/${topicName}`, value: state.topics[topicName] });
}
async function removeTopic(topicName) {
    (0, assert_1.default)(topicName, "Missing args");
    (0, assert_1.default)(state.topics[topicName], "Topic not exists");
    await service_broker_1.default.unsubscribe(topicName);
    delete state.topics[topicName];
    stateChange$.next({ op: "remove", path: `/topics/${topicName}` });
}
function subscribeTopic(client, topicName) {
    (0, assert_1.default)(client && topicName, "Missing args");
    const topic = state.topics[topicName];
    (0, assert_1.default)(topic, "Topic not found");
    client.viewTopic = topicName;
    return { payload: JSON.stringify(topicHistory[topicName] || []) };
}
function unsubscribeTopic(client) {
    client.viewTopic = undefined;
}
function onTopicMessage(topic, text) {
    const history = topicHistory[topic.topicName] || (topicHistory[topic.topicName] = []);
    history.push(text);
    if (history.length > topic.historySize)
        history.shift();
    Object.values(clients).forEach(client => {
        if (client.viewTopic == topic.topicName)
            service_broker_1.default.notifyTo(client.endpointId, "service-manager-client", { header: { method: "onTopicMessage" }, payload: text });
    });
}
function addTunnel(siteName, fromPort, toHost, toPort) {
    (0, assert_1.default)(typeof siteName == "string"
        && typeof fromPort == "number"
        && typeof toHost == "string"
        && typeof toPort == "number", "Bad args");
    const site = state.sites[siteName];
    (0, assert_1.default)(site, "Site not found");
    (0, assert_1.default)(!site.tunnels[fromPort], "Tunnel exists");
    site.tunnels[fromPort] = { toHost, toPort };
    stateChange$.next({ op: "add", path: `/sites/${siteName}/tunnels/${fromPort}`, value: site.tunnels[fromPort] });
    (0, tunnels_1.createTunnel)(site.hostName, fromPort, toHost, toPort);
}
function removeTunnel(siteName, fromPort) {
    (0, assert_1.default)(typeof siteName == "string"
        && typeof fromPort == "number", "Bad args");
    const site = state.sites[siteName];
    (0, assert_1.default)(site, "Site not found");
    (0, assert_1.default)(site.tunnels[fromPort], "Tunnel not exists");
    delete site.tunnels[fromPort];
    stateChange$.next({ op: "remove", path: `/sites/${siteName}/tunnels/${fromPort}` });
    (0, tunnels_1.destroyTunnel)(site.hostName, fromPort);
}
