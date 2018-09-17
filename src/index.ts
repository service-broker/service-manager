import * as assert from "assert"
import * as fs from "fs"
import { execFile, spawn, ChildProcess } from "child_process"
import { promisify } from "util"
import * as dotenv from "dotenv"
import { advertise, requestTo, subscribe, Message, notifyTo } from "./common/service-broker"
import { addShutdownHandler } from "./common/service-manager"
import logger from "./common/logger"
import config from "./config"

interface Site {
  siteName: string;
  hostName: string;
  operatingSystem: string;
  deployFolder: string;
  serviceBrokerUrl: string;
  services: {[key: string]: Service}
}

interface Service {
  serviceName: string;
  repoUrl: string;
  status: ServiceStatus;
  pid?: string;
  endpointId?: string;
  lastCheckedIn?: number;
}

enum ServiceStatus {
  STOPPED = "STOPPED",
  STOPPING = "STOPPING",
  STARTED = "STARTED",
  STARTING = "STARTING",
}

class Patch {
  op: string;
  path: string;
  value?: any;
}

interface Client {
  endpointId: string;
  viewLog?: {
    stdoutProc: ChildProcess,
    stderrProc: ChildProcess,
  }
  viewTopic?: string;
}

interface Topic {
  topicName: string;
  historySize: number;
}

interface State {
  sites: {[key: string]: Site};
  topics: {[key: string]: Topic};
}


const clients: {[endpointId: string]: Client} = {};
const state: State = loadState();
const topicHistory: {[key: string]: string[]} = {};

for (const topic of Object.values(state.topics)) subscribe(topic.topicName, (text: string) => onTopicMessage(topic, text));
setInterval(saveState, config.saveStateInterval);
setInterval(clientsKeepAlive, config.clientsKeepAliveInterval);

function loadState(): State {
  try {
    const text = fs.readFileSync("state.json", "utf8");
    return JSON.parse(text);
  }
  catch (err) {
    return {sites: {}, topics: {}};
  }
}

function saveState() {
  fs.writeFile("state.json", JSON.stringify(state), err => err && console.error(err));
}


advertise(config.service, onRequest)
  .then(() => logger.info(config.service.name + " service started"))
addShutdownHandler(onShutdown);

function onRequest(req: Message): Message|Promise<Message> {
  const method = req.header.method;
  const args = req.header.args || {};
  if (method == "clientLogin") return clientLogin(req.header.from);
  else if (method == "serviceCheckIn") return serviceCheckIn(args.siteName, args.serviceName, args.pid, req.header.from);

  const client = clients[req.header.from];
  if (!client) throw new Error("Unauthorized");
  else if (method == "addSite") return addSite(args.siteName, args.hostName, args.deployFolder, args.serviceBrokerUrl);
  else if (method == "removeSite") return removeSite(args.siteName);
  else if (method == "deployService") return deployService(args.siteName, args.serviceName, args.repoUrl);
  else if (method == "undeployService") return undeployService(args.siteName, args.serviceName);
  else if (method == "startService") return startService(args.siteName, args.serviceName);
  else if (method == "stopService") return stopService(args.siteName, args.serviceName);
  else if (method == "killService") return killService(args.siteName, args.serviceName);
  else if (method == "viewServiceLogs") return viewServiceLogs(args.siteName, args.serviceName, args.lines);
  else if (method == "setServiceStatus") return setServiceStatus(args.siteName, args.serviceName, args.newStatus);
  else if (method == "updateService") return updateService(args.siteName, args.serviceName);
  else if (method == "getServiceConf") return getServiceConf(args.siteName, args.serviceName);
  else if (method == "updateServiceConf") return updateServiceConf(args.siteName, args.serviceName, args.serviceConf);
  else if (method == "addTopic") return addTopic(args.topicName, args.historySize);
  else if (method == "subscribeTopic") return subscribeTopic(client, args.topicName);
  else if (method == "unsubscribeTopic") return unsubscribeTopic(client);
  else throw new Error("Unknown method " + method);
}


function clientLogin(endpointId: string): Message {
  if (clients[endpointId]) throw new Error("Already logged in");
  logger.info("Client connected", endpointId);
  clients[endpointId] = {endpointId};
  return {
    header: {serverTime: Date.now()},
    payload: JSON.stringify(state)
  };
}

function broadcastStateUpdate(patch: Patch) {
  Object.values(clients).forEach(client => {
    notifyTo(client.endpointId, "service-manager-client", {
      header: {method: "onStateUpdate"},
      payload: JSON.stringify([patch])
    })
  })
}

function clientsKeepAlive() {
  for (const client of Object.values(clients)) {
    requestTo(client.endpointId, "service-manager-client", {header: {method: "ping"}})
      .catch(err => onClientError(client, err))
  }
}

function onClientError(client: Client, err: Error) {
  logger.info("Client disconnected", client.endpointId, JSON.stringify(err.message));
  delete clients[client.endpointId];
}


async function addSite(siteName: string, hostName: string, deployFolder: string, serviceBrokerUrl: string): Promise<Message> {
  assert(siteName && hostName && deployFolder && serviceBrokerUrl, "Missing args");
  assert(!state.sites[siteName], "Site already exists");
  if (deployFolder.startsWith("~/")) deployFolder = deployFolder.slice(2);
  if (deployFolder.endsWith("/")) deployFolder = deployFolder.slice(0, -1);
  const operatingSystem = await getOperatingSystem(hostName);

  state.sites[siteName] = {
    siteName,
    hostName,
    operatingSystem,
    deployFolder,
    serviceBrokerUrl,
    services: await getDeployedServices(hostName, operatingSystem, deployFolder)
  };
  broadcastStateUpdate({op: "add", path: `/sites/${siteName}`, value: state.sites[siteName]});
  return {};
}

async function getOperatingSystem(hostName: string): Promise<string> {
  try {
    await ssh(hostName, "ls");
    return "unix";
  }
  catch (err) {
    return "windows";
  }
}

async function getDeployedServices(hostName: string, operatingSystem: string, deployFolder: string): Promise<{[key: string]: Service}> {
  const commands = config.commands[operatingSystem];
  let output = await ssh(hostName, interpolate(commands.listServices, {deployFolder}));
  output.stdout = output.stdout.trim();
  const serviceNames = output.stdout ? output.stdout.split(/\s+/) : [];
  const services: {[key: string]: Service} = {};

  for (const serviceName of serviceNames) {
    output = await ssh(hostName, interpolate(commands.readServiceConf, {deployFolder, serviceName}));
    const envInfo = dotenv.parse(output.stdout);
    services[serviceName] = {
      serviceName,
      repoUrl: envInfo.REPO_URL,
      status: ServiceStatus.STOPPED
    };
  }
  return services;
}


function removeSite(siteName: string): Message {
  assert(siteName, "Missing args");
  assert(state.sites[siteName], "Site not found");
  assert(!isSiteActive(state.sites[siteName]), "Site active");

  delete state.sites[siteName];
  broadcastStateUpdate({op: "remove", path: `/sites/${siteName}`});
  return {};
}

function isSiteActive(site: Site): boolean {
  return Object.values(site.services).some(x => x.status != ServiceStatus.STOPPED);
}


async function deployService(siteName: string, serviceName: string, repoUrl: string): Promise<Message> {
  assert(siteName && serviceName && repoUrl, "Missing args");
  const site = state.sites[siteName];
  assert(site, "Site not found");
  assert(!site.services[serviceName], "Service exists");

  const commands = config.commands[site.operatingSystem];
  let output = await ssh(site.hostName, interpolate(commands.deployService, {deployFolder: site.deployFolder, serviceName, repoUrl}));
  await writeServiceConf(site, serviceName, {REPO_URL: repoUrl, SERVICE_BROKER_URL: site.serviceBrokerUrl});
  site.services[serviceName] = {
    serviceName,
    repoUrl,
    status: ServiceStatus.STOPPED
  };
  broadcastStateUpdate({op: "add", path: `/sites/${siteName}/services/${serviceName}`, value: site.services[serviceName]});
  return {payload: JSON.stringify(output)};
}

async function readServiceConf(site: Site, serviceName: string): Promise<{[name: string]: string}> {
  const commands = config.commands[site.operatingSystem];
  const output = await ssh(site.hostName, interpolate(commands.readServiceConf, {deployFolder: site.deployFolder, serviceName}));
  return dotenv.parse(output.stdout);
}

async function writeServiceConf(site: Site, serviceName: string, props: {[name: string]: string}): Promise<void> {
  const commands = config.commands[site.operatingSystem];
  const child = spawn("ssh", [site.hostName, interpolate(commands.writeServiceConf, {deployFolder: site.deployFolder, serviceName})]);
  const promise = new Promise(fulfill => child.on("close", fulfill));
  child.stdin.end(Object.keys(props).map(name => `${name}=${props[name]}`).join('\n'));
  await promise;
}


async function undeployService(siteName: string, serviceName: string): Promise<Message> {
  assert(siteName && serviceName, "Missing args");
  const site = state.sites[siteName];
  assert(site, "Site not found");
  const service = site.services[serviceName];
  assert(service, "Service not exists");
  assert(service.status == ServiceStatus.STOPPED, "Service not stopped");

  const commands = config.commands[site.operatingSystem];
  await ssh(site.hostName, interpolate(commands.undeployService, {deployFolder: site.deployFolder, serviceName}));
  delete site.services[serviceName];
  broadcastStateUpdate({op: "remove", path: `/sites/${siteName}/services/${serviceName}`});
  return {};
}


async function startService(siteName: string, serviceName: string): Promise<Message> {
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

  const commands = config.commands[site.operatingSystem];
  await ssh(site.hostName, interpolate(commands.startService, {deployFolder: site.deployFolder, serviceName}));
  service.status = ServiceStatus.STARTING;
  broadcastStateUpdate({op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status});
  return {};
}


async function stopService(siteName: string, serviceName: string): Promise<Message> {
  assert(siteName && serviceName, "Missing args");
  const site = state.sites[siteName];
  assert(site, "Site not found");
  const service = site.services[serviceName];
  assert(service, "Service not exists");
  assert(service.status == ServiceStatus.STARTED, "Service not started");

  await requestTo(service.endpointId, "service-manager-client", {header: {method: "shutdown", pid: service.pid}});
  service.status = ServiceStatus.STOPPING;
  broadcastStateUpdate({op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status});

  waitUntilStopped(site, service);
  return {};
}

async function waitUntilStopped(site: Site, service: Service): Promise<void> {
  try {
    const commands = config.commands[site.operatingSystem];
    for (let i=0; i<10; i++) {
      await ssh(site.hostName, interpolate(commands.checkService, {pid: service.pid}));
      await promisify(setTimeout)(3000);
    }
  }
  catch (err) {
    service.status = ServiceStatus.STOPPED;
    service.pid = null;
    service.endpointId = null;
    service.lastCheckedIn = null;
    broadcastStateUpdate({op: "replace", path: `/sites/${site.siteName}/services/${service.serviceName}`, value: service});
  }
}


async function killService(siteName: string, serviceName: string): Promise<Message> {
  assert(siteName && serviceName, "Missing args");
  const site = state.sites[siteName];
  assert(site, "Site not found");
  const service = site.services[serviceName];
  assert(service, "Service not exists");
  assert(service.status == ServiceStatus.STARTED || service.status == ServiceStatus.STOPPING, "Service not started or stopping");

  const commands = config.commands[site.operatingSystem];
  await ssh(site.hostName, interpolate(commands.killService, {pid: service.pid}));
  if (service.status != ServiceStatus.STOPPING) {
    service.status = ServiceStatus.STOPPING;
    broadcastStateUpdate({op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status});
  }

  waitUntilStopped(site, service);
  return {};
}


async function viewServiceLogs(siteName: string, serviceName: string, lines: number): Promise<Message> {
  assert(siteName && serviceName && lines, "Missing args");
  const site = state.sites[siteName];
  assert(site, "Site not found");
  const service = site.services[serviceName];
  assert(service, "Service not exists");

  const commands = config.commands[site.operatingSystem];
  let output = await ssh(site.hostName, interpolate(commands.viewServiceLogs, {deployFolder: site.deployFolder, serviceName, lines}));
  return {payload: JSON.stringify(output)};
}


function setServiceStatus(siteName: string, serviceName: string, newStatus: ServiceStatus): Message {
  assert(siteName && serviceName && newStatus, "Missing args");
  const site = state.sites[siteName];
  assert(site, "Site not found");
  const service = site.services[serviceName];
  assert(service, "Service not exists");

  if (service.status != newStatus) {
    service.status = newStatus;
    broadcastStateUpdate({op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status});
  }
  return {};
}


async function updateService(siteName: string, serviceName: string): Promise<Message> {
  assert(siteName && serviceName, "Missing args");
  const site = state.sites[siteName];
  assert(site, "Site not found");
  const service = site.services[serviceName];
  assert(service, "Service not exists");

  const commands = config.commands[site.operatingSystem];
  let output = await ssh(site.hostName, interpolate(commands.updateService, {deployFolder: site.deployFolder, serviceName}));
  return {payload: JSON.stringify(output)};
}


async function getServiceConf(siteName: string, serviceName: string): Promise<Message> {
  assert(siteName && serviceName, "Missing args");
  const site = state.sites[siteName];
  assert(site, "Site not found");

  const props = await readServiceConf(site, serviceName);
  return {header: {serviceConf: props}};
}

async function updateServiceConf(siteName: string, serviceName: string, serviceConf: {[name: string]: string}): Promise<Message> {
  assert(siteName && serviceName, "Missing args");
  const site = state.sites[siteName];
  assert(site, "Site not found");

  await writeServiceConf(site, serviceName, serviceConf);
  return {};
}


function serviceCheckIn(siteName: string, serviceName: string, pid: string, endpointId: string): Message {
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
    broadcastStateUpdate({op: "replace", path: `/sites/${siteName}/services/${serviceName}`, value: service});
  }
  return {};
}


function addTopic(topicName: string, historySize: number): Message {
  assert(topicName && historySize, "Missing args");
  assert(!state.topics[topicName], "Topic already exists");

  const topic = state.topics[topicName] = {
    topicName,
    historySize,
  };
  broadcastStateUpdate({op: "add", path: `/topics/${topicName}`, value: state.topics[topicName]});

  subscribe(topic.topicName, (text: string) => onTopicMessage(topic, text));
  return {};
}

function subscribeTopic(client: Client, topicName: string): Message {
  assert(client && topicName, "Missing args");
  const topic = state.topics[topicName];
  assert(topic, "Topic not found");

  client.viewTopic = topicName;
  return {payload: JSON.stringify(topicHistory[topicName] || [])};
}

function unsubscribeTopic(client: Client): Message {
  client.viewTopic = null;
  return {};
}

function onTopicMessage(topic: Topic, text: string) {
  const history = topicHistory[topic.topicName] || (topicHistory[topic.topicName] = []);
  history.push(text);
  if (history.length > topic.historySize) history.shift();

  Object.values(clients).forEach(client => {
    if (client.viewTopic == topic.topicName)
      notifyTo(client.endpointId, "service-manager-client", {header: {method: "onTopicMessage"}, payload: text});
  })
}



function ssh(hostName: string, command:string) {
  return promisify(execFile)("ssh", ["-o", "BatchMode=yes", hostName, command]);
}

function interpolate(template: string, vars: {[key: string]: any}) {
  for (const name in vars) template = template.split("${" + name + "}").join(vars[name]);
  return template;
}

function onShutdown(): Promise<void> {
  logger.info("Shutdown request received");
  return Promise.resolve();
}
