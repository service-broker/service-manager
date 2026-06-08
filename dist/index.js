import assert from "assert";
import dotenv from "dotenv";
import fsp from "fs/promises";
import * as rxjs from "rxjs";
import { tmpName } from "tmp";
import logger from "./common/logger.js";
import sb from "./common/service-broker.js";
import { shutdown$ } from "./common/service-manager.js";
import { interpolate, scp, ssh } from "./common/util.js";
import config from "./config.js";
import { createTunnel, destroyTunnel } from "./tunnels.js";
var ServiceStatus;
(function (ServiceStatus) {
    ServiceStatus["STOPPED"] = "STOPPED";
    ServiceStatus["STOPPING"] = "STOPPING";
    ServiceStatus["STARTED"] = "STARTED";
    ServiceStatus["STARTING"] = "STARTING";
})(ServiceStatus || (ServiceStatus = {}));
const clients = {};
const state = await loadState();
const stateChange$ = new rxjs.Subject();
const topicHistory = {};
for (const topic of Object.values(state.topics)) {
    sb.subscribe(topic.topicName, (text) => onTopicMessage(topic, text));
}
rxjs.merge(rxjs.interval(config.clientsKeepAliveInterval).pipe(rxjs.tap(clientsKeepAlive)), stateChange$.pipe(rxjs.tap(broadcastStateUpdate)), stateChange$.pipe(rxjs.auditTime(1000), rxjs.tap(saveState))).subscribe({
    error(err) {
        logger.error('FATAL', new Error('Job failed', { cause: err }));
        shutdown$.next();
    }
});
async function loadState() {
    try {
        const text = await fsp.readFile("state.json", "utf8");
        const state = JSON.parse(text);
        for (const siteName in state.sites) {
            const site = state.sites[siteName];
            if (!site.tunnels)
                site.tunnels = {};
            for (const fromPort in site.tunnels) {
                const { toHost, toPort } = site.tunnels[fromPort];
                createTunnel(site.hostName, Number(fromPort), toHost, toPort);
            }
        }
        return state;
    }
    catch (err) {
        return { sites: {}, topics: {} };
    }
}
function saveState() {
    fsp.writeFile("state.json", JSON.stringify(state))
        .catch(logger.error);
}
sb.advertise(config.service, onRequest)
    .then(() => logger.info(config.service.name + " service started"));
function onRequest(req) {
    assert(typeof req.header.from == 'string');
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
        return deployService(args.siteName, args.serviceName, args.repoUrl, args.repoTag, args.startCommand);
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
    if (password != config.password)
        throw new Error("Wrong password");
    if (clients[endpointId])
        throw new Error("Already logged in");
    logger.info("Client connected", endpointId);
    clients[endpointId] = { endpointId };
    return {
        header: { serverTime: Date.now() },
        payload: JSON.stringify({
            ...state,
            config: {
                startCommand: config.startCommand
            }
        })
    };
}
function broadcastStateUpdate(patch) {
    Object.values(clients).forEach(client => {
        sb.notifyTo(client.endpointId, "service-manager-client", {
            header: { method: "onStateUpdate" },
            payload: JSON.stringify([patch])
        });
    });
}
function clientsKeepAlive() {
    for (const client of Object.values(clients)) {
        sb.requestTo(client.endpointId, "service-manager-client", { header: { method: "ping" } })
            .catch(err => onClientError(client, err));
    }
}
function onClientError(client, err) {
    logger.info("Client disconnected", client.endpointId, JSON.stringify(err.message));
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
        services: {},
        tunnels: {},
    };
    site.services = await getDeployedServices(site);
    state.sites[siteName] = site;
    stateChange$.next({ op: "add", path: `/sites/${siteName}`, value: site });
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
    const commands = config.commands[site.operatingSystem];
    let output = await ssh(site.hostName, interpolate(commands.listServices, { deployFolder: site.deployFolder }));
    output.stdout = output.stdout.trim();
    const serviceNames = output.stdout ? output.stdout.split(/\s+/) : [];
    const services = {};
    for (const serviceName of serviceNames) {
        const envInfo = await readServiceConf(site, serviceName);
        assert(envInfo.REPO_URL, "Missing env REPO_URL for service " + serviceName);
        services[serviceName] = {
            serviceName,
            repoUrl: envInfo.REPO_URL,
            repoTag: envInfo.REPO_TAG,
            startCommand: envInfo.START_COMMAND,
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
    stateChange$.next({ op: "remove", path: `/sites/${siteName}` });
}
function isSiteActive(site) {
    return Object.values(site.services).some(x => x.status != ServiceStatus.STOPPED)
        || Object.values(site.tunnels).length > 0;
}
async function deployService(siteName, serviceName, repoUrl, repoTag, startCommand) {
    assert(siteName && serviceName && repoUrl, "Missing args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    assert(!site.services[serviceName], "Service exists");
    const commands = config.commands[site.operatingSystem];
    let output = await ssh(site.hostName, interpolate(commands.deployService, {
        deployFolder: site.deployFolder,
        serviceName,
        repoUrl,
        repoTag: repoTag || "master",
    }));
    await writeServiceConf(site, serviceName, {
        REPO_URL: repoUrl,
        REPO_TAG: repoTag,
        START_COMMAND: startCommand,
        SERVICE_BROKER_URL: site.serviceBrokerUrl,
        SITE_NAME: siteName,
        SERVICE_NAME: serviceName,
    });
    site.services[serviceName] = {
        serviceName,
        repoUrl,
        repoTag,
        startCommand,
        status: ServiceStatus.STOPPED
    };
    stateChange$.next({ op: "add", path: `/sites/${siteName}/services/${serviceName}`, value: site.services[serviceName] });
    return { payload: JSON.stringify(output) };
}
async function readServiceConf(site, serviceName) {
    const commands = config.commands[site.operatingSystem];
    const output = await ssh(site.hostName, interpolate(commands.readServiceConf, { deployFolder: site.deployFolder, serviceName }));
    return dotenv.parse(output.stdout);
}
async function writeServiceConf(site, serviceName, props) {
    const file = await new Promise((fulfill, reject) => tmpName((err, path) => err ? reject(err) : fulfill(path)));
    const text = Object.keys(props)
        .filter(name => props[name] != undefined)
        .map(name => `${name}=${props[name]}`)
        .join('\n');
    await fsp.writeFile(file, text);
    await scp(file, `${site.hostName}:${site.deployFolder}/${serviceName}/.env`);
    await fsp.unlink(file);
}
async function undeployService(siteName, serviceName) {
    assert(siteName && serviceName, "Missing args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    const service = site.services[serviceName];
    assert(service, "Service not exists");
    assert(service.status == ServiceStatus.STOPPED, "Service not stopped");
    const commands = config.commands[site.operatingSystem];
    await ssh(site.hostName, interpolate(commands.undeployService, { deployFolder: site.deployFolder, serviceName }));
    delete site.services[serviceName];
    stateChange$.next({ op: "remove", path: `/sites/${siteName}/services/${serviceName}` });
}
async function startService(siteName, serviceName) {
    assert(siteName && serviceName, "Missing args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    const service = site.services[serviceName];
    assert(service, "Service not exists");
    assert(service.status == ServiceStatus.STOPPED, "Service not stopped");
    const commands = config.commands[site.operatingSystem];
    ssh(site.hostName, interpolate(commands.startService, {
        deployFolder: site.deployFolder,
        serviceName,
        startCommand: service.startCommand || config.startCommand
    }))
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
    assert(siteName && serviceName, "Missing args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    const service = site.services[serviceName];
    assert(service, "Service not exists");
    assert(service.status == ServiceStatus.STARTED, "Service not started");
    assert(service.endpointId, "FATAL endpointId null");
    await sb.requestTo(service.endpointId, "service-manager-client", { header: { method: "shutdown", pid: service.pid } });
    service.status = ServiceStatus.STOPPING;
    stateChange$.next({ op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status });
    waitUntilStopped(site, service, 6);
}
async function waitUntilStopped(site, service, timeout) {
    try {
        const commands = config.commands[site.operatingSystem];
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
    const commands = config.commands[site.operatingSystem];
    await ssh(site.hostName, interpolate(commands.killService, { pid: service.pid }));
    if (service.status != ServiceStatus.STOPPING) {
        service.status = ServiceStatus.STOPPING;
        stateChange$.next({ op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status });
    }
    waitUntilStopped(site, service, 3);
}
async function viewServiceLogs(siteName, serviceName, lines) {
    assert(siteName && serviceName && lines, "Missing args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    const service = site.services[serviceName];
    assert(service, "Service not exists");
    const commands = config.commands[site.operatingSystem];
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
        stateChange$.next({ op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status });
    }
}
async function updateService(siteName, serviceName) {
    assert(siteName && serviceName, "Missing args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    const service = site.services[serviceName];
    assert(service, "Service not exists");
    const commands = config.commands[site.operatingSystem];
    let output = await ssh(site.hostName, interpolate(commands.updateService, {
        deployFolder: site.deployFolder,
        serviceName,
        repoTag: service.repoTag || "master"
    }));
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
    const service = site.services[serviceName];
    assert(service, "Service not exists");
    await writeServiceConf(site, serviceName, serviceConf);
    service.repoUrl = serviceConf.REPO_URL || service.repoUrl;
    service.repoTag = serviceConf.REPO_TAG || undefined;
    service.startCommand = serviceConf.START_COMMAND || undefined;
    stateChange$.next({ op: "replace", path: `/sites/${siteName}/services/${serviceName}`, value: service });
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
        stateChange$.next({ op: "replace", path: `/sites/${siteName}/services/${serviceName}`, value: service });
    }
}
async function addTopic(topicName, historySize) {
    assert(topicName && historySize, "Missing args");
    assert(!state.topics[topicName], "Topic already exists");
    const topic = { topicName, historySize };
    await sb.subscribe(topic.topicName, (text) => onTopicMessage(topic, text));
    state.topics[topicName] = topic;
    stateChange$.next({ op: "add", path: `/topics/${topicName}`, value: state.topics[topicName] });
}
async function removeTopic(topicName) {
    assert(topicName, "Missing args");
    assert(state.topics[topicName], "Topic not exists");
    await sb.unsubscribe(topicName);
    delete state.topics[topicName];
    stateChange$.next({ op: "remove", path: `/topics/${topicName}` });
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
}
function onTopicMessage(topic, text) {
    const history = topicHistory[topic.topicName] || (topicHistory[topic.topicName] = []);
    history.push(text);
    if (history.length > topic.historySize)
        history.shift();
    Object.values(clients).forEach(client => {
        if (client.viewTopic == topic.topicName)
            sb.notifyTo(client.endpointId, "service-manager-client", { header: { method: "onTopicMessage" }, payload: text });
    });
}
function addTunnel(siteName, fromPort, toHost, toPort) {
    assert(typeof siteName == "string"
        && typeof fromPort == "number"
        && typeof toHost == "string"
        && typeof toPort == "number", "Bad args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    assert(!site.tunnels[fromPort], "Tunnel exists");
    site.tunnels[fromPort] = { toHost, toPort };
    stateChange$.next({ op: "add", path: `/sites/${siteName}/tunnels/${fromPort}`, value: site.tunnels[fromPort] });
    createTunnel(site.hostName, fromPort, toHost, toPort);
}
function removeTunnel(siteName, fromPort) {
    assert(typeof siteName == "string"
        && typeof fromPort == "number", "Bad args");
    const site = state.sites[siteName];
    assert(site, "Site not found");
    assert(site.tunnels[fromPort], "Tunnel not exists");
    delete site.tunnels[fromPort];
    stateChange$.next({ op: "remove", path: `/sites/${siteName}/tunnels/${fromPort}` });
    destroyTunnel(site.hostName, fromPort);
}
