"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const child_process_1 = require("child_process");
const dotenv = require("dotenv");
const fs = require("fs");
const tmp_1 = require("tmp");
const util_1 = require("util");
const logger_1 = require("./common/logger");
const service_broker_1 = require("./common/service-broker");
const service_manager_1 = require("./common/service-manager");
const config_1 = require("./config");
var ServiceStatus;
(function (ServiceStatus) {
    ServiceStatus["STOPPED"] = "STOPPED";
    ServiceStatus["STOPPING"] = "STOPPING";
    ServiceStatus["STARTED"] = "STARTED";
    ServiceStatus["STARTING"] = "STARTING";
})(ServiceStatus || (ServiceStatus = {}));
const clients = {};
const state = loadState();
const topicHistory = {};
for (const topic of Object.values(state.topics))
    service_broker_1.default.subscribe(topic.topicName, (text) => onTopicMessage(topic, text));
setInterval(saveState, config_1.default.saveStateInterval);
setInterval(clientsKeepAlive, config_1.default.clientsKeepAliveInterval);
function loadState() {
    try {
        const text = fs.readFileSync("state.json", "utf8");
        return JSON.parse(text);
    }
    catch (err) {
        return { sites: {}, topics: {} };
    }
}
function saveState() {
    fs.writeFile("state.json", JSON.stringify(state), err => err && console.error(err));
}
service_broker_1.default.advertise(config_1.default.service, onRequest)
    .then(() => logger_1.default.info(config_1.default.service.name + " service started"));
(0, service_manager_1.addShutdownHandler)(onShutdown);
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
        return deployService(args.siteName, args.serviceName, args.repoUrl);
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
    assert(siteName && hostName && deployFolder && serviceBrokerUrl, "Missing args");
    assert(!state.sites[siteName], "Site already exists");
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
        services: {}
    };
    site.services = await getDeployedServices(site);
    state.sites[siteName] = site;
    broadcastStateUpdate({ op: "add", path: `/sites/${siteName}`, value: site });
    return {};
}
async function getOperatingSystem(hostName) {
    try {
        await ssh(hostName, "ls");
        return "unix";
    }
    catch (err) {
        return "windows";
    }
}
async function getDeployedServices(site) {
    const commands = config_1.default.commands[site.operatingSystem];
    let output = await ssh(site.hostName, interpolate(commands.listServices, { deployFolder: site.deployFolder }));
    output.stdout = output.stdout.trim();
    const serviceNames = output.stdout ? output.stdout.split(/\s+/) : [];
    const services = {};
    for (const serviceName of serviceNames) {
        const envInfo = await readServiceConf(site, serviceName);
        services[serviceName] = {
            serviceName,
            repoUrl: envInfo.REPO_URL,
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
    assert(siteName, "Missing args");
    assert(state.sites[siteName], "Site not found");
    assert(!isSiteActive(state.sites[siteName]), "Site active");
    delete state.sites[siteName];
    broadcastStateUpdate({ op: "remove", path: `/sites/${siteName}` });
    return {};
}
function isSiteActive(site) {
    return Object.values(site.services).some(x => x.status != ServiceStatus.STOPPED);
}
async function deployService(siteName, serviceName, repoUrl) {
    assert(siteName && serviceName && repoUrl, "Missing args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    assert(!site.services[serviceName], "Service exists");
    const commands = config_1.default.commands[site.operatingSystem];
    let output = await ssh(site.hostName, interpolate(commands.deployService, { deployFolder: site.deployFolder, serviceName, repoUrl }));
    await writeServiceConf(site, serviceName, {
        REPO_URL: repoUrl,
        SERVICE_BROKER_URL: site.serviceBrokerUrl,
        SITE_NAME: siteName,
        SERVICE_NAME: serviceName,
    });
    site.services[serviceName] = {
        serviceName,
        repoUrl,
        status: ServiceStatus.STOPPED
    };
    broadcastStateUpdate({ op: "add", path: `/sites/${siteName}/services/${serviceName}`, value: site.services[serviceName] });
    return { payload: JSON.stringify(output) };
}
async function readServiceConf(site, serviceName) {
    const commands = config_1.default.commands[site.operatingSystem];
    const output = await ssh(site.hostName, interpolate(commands.readServiceConf, { deployFolder: site.deployFolder, serviceName }));
    return dotenv.parse(output.stdout);
}
async function writeServiceConf(site, serviceName, props) {
    const file = await new Promise((fulfill, reject) => (0, tmp_1.tmpName)((err, path) => err ? reject(err) : fulfill(path)));
    const text = Object.keys(props).map(name => `${name}=${props[name]}`).join('\n');
    await (0, util_1.promisify)(fs.writeFile)(file, text);
    await scp(file, `${site.hostName}:${site.deployFolder}/${serviceName}/.env`);
    await (0, util_1.promisify)(fs.unlink)(file);
}
async function undeployService(siteName, serviceName) {
    assert(siteName && serviceName, "Missing args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    const service = site.services[serviceName];
    assert(service, "Service not exists");
    assert(service.status == ServiceStatus.STOPPED, "Service not stopped");
    const commands = config_1.default.commands[site.operatingSystem];
    await ssh(site.hostName, interpolate(commands.undeployService, { deployFolder: site.deployFolder, serviceName }));
    delete site.services[serviceName];
    broadcastStateUpdate({ op: "remove", path: `/sites/${siteName}/services/${serviceName}` });
    return {};
}
async function startService(siteName, serviceName) {
    assert(siteName && serviceName, "Missing args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    const service = site.services[serviceName];
    assert(service, "Service not exists");
    assert(service.status == ServiceStatus.STOPPED, "Service not stopped");
    const commands = config_1.default.commands[site.operatingSystem];
    ssh(site.hostName, interpolate(commands.startService, { deployFolder: site.deployFolder, serviceName }))
        .catch(err => "OK")
        .then(() => setStopped(site, service));
    service.status = ServiceStatus.STARTING;
    broadcastStateUpdate({ op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status });
    return {};
}
function setStopped(site, service) {
    if (service.status == ServiceStatus.STOPPED)
        return;
    service.status = ServiceStatus.STOPPED;
    service.pid = undefined;
    service.endpointId = undefined;
    service.lastCheckedIn = undefined;
    broadcastStateUpdate({ op: "replace", path: `/sites/${site.siteName}/services/${service.serviceName}`, value: service });
}
async function stopService(siteName, serviceName) {
    assert(siteName && serviceName, "Missing args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    const service = site.services[serviceName];
    assert(service, "Service not exists");
    assert(service.status == ServiceStatus.STARTED, "Service not started");
    assert(service.endpointId, "FATAL endpointId null");
    await service_broker_1.default.requestTo(service.endpointId, "service-manager-client", { header: { method: "shutdown", pid: service.pid } });
    service.status = ServiceStatus.STOPPING;
    broadcastStateUpdate({ op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status });
    waitUntilStopped(site, service, 6);
    return {};
}
async function waitUntilStopped(site, service, timeout) {
    try {
        const commands = config_1.default.commands[site.operatingSystem];
        await ssh(site.hostName, interpolate(commands.checkService, { pid: service.pid, timeout }));
    }
    catch (err) {
        setStopped(site, service);
    }
}
async function killService(siteName, serviceName) {
    assert(siteName && serviceName, "Missing args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    const service = site.services[serviceName];
    assert(service, "Service not exists");
    assert(service.status == ServiceStatus.STARTED || service.status == ServiceStatus.STOPPING, "Service not started or stopping");
    const commands = config_1.default.commands[site.operatingSystem];
    await ssh(site.hostName, interpolate(commands.killService, { pid: service.pid }));
    if (service.status != ServiceStatus.STOPPING) {
        service.status = ServiceStatus.STOPPING;
        broadcastStateUpdate({ op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status });
    }
    waitUntilStopped(site, service, 3);
    return {};
}
async function viewServiceLogs(siteName, serviceName, lines) {
    assert(siteName && serviceName && lines, "Missing args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    const service = site.services[serviceName];
    assert(service, "Service not exists");
    const commands = config_1.default.commands[site.operatingSystem];
    let output = await ssh(site.hostName, interpolate(commands.viewServiceLogs, { deployFolder: site.deployFolder, serviceName, lines }));
    return { payload: JSON.stringify(output) };
}
function setServiceStatus(siteName, serviceName, newStatus) {
    assert(siteName && serviceName && newStatus, "Missing args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    const service = site.services[serviceName];
    assert(service, "Service not exists");
    if (service.status != newStatus) {
        service.status = newStatus;
        broadcastStateUpdate({ op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status });
    }
    return {};
}
async function updateService(siteName, serviceName) {
    assert(siteName && serviceName, "Missing args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    const service = site.services[serviceName];
    assert(service, "Service not exists");
    const commands = config_1.default.commands[site.operatingSystem];
    let output = await ssh(site.hostName, interpolate(commands.updateService, { deployFolder: site.deployFolder, serviceName }));
    return { payload: JSON.stringify(output) };
}
async function getServiceConf(siteName, serviceName) {
    assert(siteName && serviceName, "Missing args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    const props = await readServiceConf(site, serviceName);
    return { header: { serviceConf: props } };
}
async function updateServiceConf(siteName, serviceName, serviceConf) {
    assert(siteName && serviceName, "Missing args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    await writeServiceConf(site, serviceName, serviceConf);
    return {};
}
function serviceCheckIn(siteName, serviceName, pid, endpointId) {
    assert(siteName && serviceName && pid && endpointId, "Missing args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    const service = site.services[serviceName];
    assert(service, "Service not exists");
    if (service.status == ServiceStatus.STARTED && service.pid == pid && service.endpointId == endpointId) {
        service.lastCheckedIn = Date.now();
    }
    else {
        service.status = ServiceStatus.STARTED;
        service.pid = pid;
        service.endpointId = endpointId;
        service.lastCheckedIn = Date.now();
        broadcastStateUpdate({ op: "replace", path: `/sites/${siteName}/services/${serviceName}`, value: service });
    }
    return {};
}
async function addTopic(topicName, historySize) {
    assert(topicName && historySize, "Missing args");
    assert(!state.topics[topicName], "Topic already exists");
    const topic = { topicName, historySize };
    await service_broker_1.default.subscribe(topic.topicName, (text) => onTopicMessage(topic, text));
    state.topics[topicName] = topic;
    broadcastStateUpdate({ op: "add", path: `/topics/${topicName}`, value: state.topics[topicName] });
    return {};
}
async function removeTopic(topicName) {
    assert(topicName, "Missing args");
    assert(state.topics[topicName], "Topic not exists");
    await service_broker_1.default.unsubscribe(topicName);
    delete state.topics[topicName];
    broadcastStateUpdate({ op: "remove", path: `/topics/${topicName}` });
    return {};
}
function subscribeTopic(client, topicName) {
    assert(client && topicName, "Missing args");
    const topic = state.topics[topicName];
    assert(topic, "Topic not found");
    client.viewTopic = topicName;
    return { payload: JSON.stringify(topicHistory[topicName] || []) };
}
function unsubscribeTopic(client) {
    client.viewTopic = undefined;
    return {};
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
function onShutdown() {
    logger_1.default.info("Shutdown request received");
    return Promise.resolve();
}
