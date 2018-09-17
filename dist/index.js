"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
const fs = require("fs");
const child_process_1 = require("child_process");
const util_1 = require("util");
const dotenv = require("dotenv");
const service_broker_1 = require("./common/service-broker");
const service_manager_1 = require("./common/service-manager");
const logger_1 = require("./common/logger");
const config_1 = require("./config");
var ServiceStatus;
(function (ServiceStatus) {
    ServiceStatus["STOPPED"] = "STOPPED";
    ServiceStatus["STOPPING"] = "STOPPING";
    ServiceStatus["STARTED"] = "STARTED";
    ServiceStatus["STARTING"] = "STARTING";
})(ServiceStatus || (ServiceStatus = {}));
class Patch {
}
const clients = {};
const state = loadState();
const topicHistory = {};
for (const topic of Object.values(state.topics))
    service_broker_1.subscribe(topic.topicName, (text) => onTopicMessage(topic, text));
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
service_broker_1.advertise(config_1.default.service, onRequest)
    .then(() => logger_1.default.info(config_1.default.service.name + " service started"));
service_manager_1.addShutdownHandler(onShutdown);
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
        service_broker_1.notifyTo(client.endpointId, "service-manager-client", {
            header: { method: "onStateUpdate" },
            payload: JSON.stringify([patch])
        });
    });
}
function clientsKeepAlive() {
    for (const client of Object.values(clients)) {
        service_broker_1.requestTo(client.endpointId, "service-manager-client", { header: { method: "ping" } })
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
    state.sites[siteName] = {
        siteName,
        hostName,
        operatingSystem,
        deployFolder,
        serviceBrokerUrl,
        services: await getDeployedServices(hostName, operatingSystem, deployFolder)
    };
    broadcastStateUpdate({ op: "add", path: `/sites/${siteName}`, value: state.sites[siteName] });
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
async function getDeployedServices(hostName, operatingSystem, deployFolder) {
    const commands = config_1.default.commands[operatingSystem];
    let output = await ssh(hostName, interpolate(commands.listServices, { deployFolder }));
    output.stdout = output.stdout.trim();
    const serviceNames = output.stdout ? output.stdout.split(/\s+/) : [];
    const services = {};
    for (const serviceName of serviceNames) {
        output = await ssh(hostName, interpolate(commands.readServiceConf, { deployFolder, serviceName }));
        const envInfo = dotenv.parse(output.stdout);
        services[serviceName] = {
            serviceName,
            repoUrl: envInfo.REPO_URL,
            status: ServiceStatus.STOPPED
        };
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
    await writeServiceConf(site, serviceName, { REPO_URL: repoUrl, SERVICE_BROKER_URL: site.serviceBrokerUrl });
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
    const commands = config_1.default.commands[site.operatingSystem];
    const child = child_process_1.spawn("ssh", [site.hostName, interpolate(commands.writeServiceConf, { deployFolder: site.deployFolder, serviceName })]);
    const promise = new Promise(fulfill => child.on("close", fulfill));
    child.stdin.end(Object.keys(props).map(name => `${name}=${props[name]}`).join('\n'));
    await promise;
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
    const props = await readServiceConf(site, serviceName);
    props.SITE_NAME = siteName;
    props.SERVICE_NAME = serviceName;
    await writeServiceConf(site, serviceName, props);
    const commands = config_1.default.commands[site.operatingSystem];
    await ssh(site.hostName, interpolate(commands.startService, { deployFolder: site.deployFolder, serviceName }));
    service.status = ServiceStatus.STARTING;
    broadcastStateUpdate({ op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status });
    return {};
}
async function stopService(siteName, serviceName) {
    assert(siteName && serviceName, "Missing args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    const service = site.services[serviceName];
    assert(service, "Service not exists");
    assert(service.status == ServiceStatus.STARTED, "Service not started");
    await service_broker_1.requestTo(service.endpointId, "service-manager-client", { header: { method: "shutdown", pid: service.pid } });
    service.status = ServiceStatus.STOPPING;
    broadcastStateUpdate({ op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status });
    waitUntilStopped(site, service);
    return {};
}
async function waitUntilStopped(site, service) {
    try {
        const commands = config_1.default.commands[site.operatingSystem];
        for (let i = 0; i < 10; i++) {
            await ssh(site.hostName, interpolate(commands.checkService, { pid: service.pid }));
            await util_1.promisify(setTimeout)(3000);
        }
    }
    catch (err) {
        service.status = ServiceStatus.STOPPED;
        service.pid = null;
        service.endpointId = null;
        service.lastCheckedIn = null;
        broadcastStateUpdate({ op: "replace", path: `/sites/${site.siteName}/services/${service.serviceName}`, value: service });
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
    waitUntilStopped(site, service);
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
function addTopic(topicName, historySize) {
    assert(topicName && historySize, "Missing args");
    assert(!state.topics[topicName], "Topic already exists");
    const topic = state.topics[topicName] = {
        topicName,
        historySize,
    };
    broadcastStateUpdate({ op: "add", path: `/topics/${topicName}`, value: state.topics[topicName] });
    service_broker_1.subscribe(topic.topicName, (text) => onTopicMessage(topic, text));
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
    client.viewTopic = null;
    return {};
}
function onTopicMessage(topic, text) {
    const history = topicHistory[topic.topicName] || (topicHistory[topic.topicName] = []);
    history.push(text);
    if (history.length > topic.historySize)
        history.shift();
    Object.values(clients).forEach(client => {
        if (client.viewTopic == topic.topicName)
            service_broker_1.notifyTo(client.endpointId, "service-manager-client", { header: { method: "onTopicMessage" }, payload: text });
    });
}
function ssh(hostName, command) {
    return util_1.promisify(child_process_1.execFile)("ssh", ["-o", "BatchMode=yes", hostName, command]);
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
