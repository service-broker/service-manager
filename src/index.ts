import { Message, MessageWithHeader } from "@service-broker/service-broker-client";
import assert from "assert";
import { ChildProcess } from "child_process";
import dotenv from "dotenv";
import fs from "fs";
import * as rxjs from "rxjs";
import { tmpName } from "tmp";
import { promisify } from "util";
import logger from "./common/logger";
import sb from "./common/service-broker";
import { addShutdownHandler } from "./common/service-manager";
import { interpolate, scp, ssh } from "./common/util";
import config from "./config";
import { createTunnel, destroyTunnel } from "./tunnels";

interface Site {
  siteName: string;
  hostName: string;
  operatingSystem: string;
  deployFolder: string;
  serviceBrokerUrl: string;
  services: {[key: string]: Service}
  tunnels: {[fromPort: number]: Tunnel}
}

interface Service {
  serviceName: string;
  repoUrl: string;
  repoTag?: string;
  status: ServiceStatus;
  pid?: string;
  endpointId?: string;
  lastCheckedIn?: number;
}

interface Tunnel {
  toHost: string
  toPort: number
}

enum ServiceStatus {
  STOPPED = "STOPPED",
  STOPPING = "STOPPING",
  STARTED = "STARTED",
  STARTING = "STARTING",
}

interface Patch {
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
const stateChange$ = new rxjs.Subject<Patch>()
const topicHistory: {[key: string]: string[]} = {};

for (const topic of Object.values(state.topics)) {
  sb.subscribe(topic.topicName, (text: string) => onTopicMessage(topic, text))
}


const jobs = [
  rxjs.interval(config.clientsKeepAliveInterval).subscribe(clientsKeepAlive),
  stateChange$.subscribe(broadcastStateUpdate),
  stateChange$.pipe(rxjs.auditTime(1000)).subscribe(saveState),
]
addShutdownHandler(() => {
  for (const job of jobs) job.unsubscribe()
})

function loadState(): State {
  try {
    const text = fs.readFileSync("state.json", "utf8");
    const state = JSON.parse(text) as State
    for (const siteName in state.sites) {
      const site = state.sites[siteName]
      if (!site.tunnels) site.tunnels = {}
      for (const fromPort in site.tunnels) {
        const {toHost, toPort} = site.tunnels[fromPort]
        createTunnel(site.hostName, Number(fromPort), toHost, toPort)
      }
    }
    return state
  }
  catch (err) {
    return {sites: {}, topics: {}};
  }
}

function saveState() {
  fs.writeFile("state.json", JSON.stringify(state), err => err && console.error(err));
}


sb.advertise(config.service, onRequest)
  .then(() => logger.info(config.service.name + " service started"))

function onRequest(req: MessageWithHeader): Message|void|Promise<Message|void> {
  const method = req.header.method;
  const args = req.header.args || {};
  if (method == "clientLogin") return clientLogin(args.password, req.header.from);
  else if (method == "serviceCheckIn") return serviceCheckIn(args.siteName, args.serviceName, args.pid, req.header.from);

  const client = clients[req.header.from];
  if (!client) throw new Error("Unauthorized");
  else if (method == "addSite") return addSite(args.siteName, args.hostName, args.deployFolder, args.serviceBrokerUrl);
  else if (method == "removeSite") return removeSite(args.siteName);
  else if (method == "deployService") return deployService(args.siteName, args.serviceName, args.repoUrl, args.repoTag);
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
  else if (method == "removeTopic") return removeTopic(args.topicName);
  else if (method == "subscribeTopic") return subscribeTopic(client, args.topicName);
  else if (method == "unsubscribeTopic") return unsubscribeTopic(client);
  else if (method == "addTunnel") return addTunnel(args.siteName, args.fromPort, args.toHost, args.toPort)
  else if (method == "removeTunnel") return removeTunnel(args.siteName, args.fromPort)
  else throw new Error("Unknown method " + method);
}


function clientLogin(password: string, endpointId: string): Message {
  if (password != config.password) throw new Error("Wrong password");
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
    sb.notifyTo(client.endpointId, "service-manager-client", {
      header: {method: "onStateUpdate"},
      payload: JSON.stringify([patch])
    })
  })
}

function clientsKeepAlive() {
  for (const client of Object.values(clients)) {
    sb.requestTo(client.endpointId, "service-manager-client", {header: {method: "ping"}})
      .catch(err => onClientError(client, err))
  }
}

function onClientError(client: Client, err: Error) {
  logger.info("Client disconnected", client.endpointId, JSON.stringify(err.message));
  delete clients[client.endpointId];
}


async function addSite(siteName: string, hostName: string, deployFolder: string, serviceBrokerUrl: string): Promise<void> {
  assert(siteName && hostName && deployFolder && serviceBrokerUrl, "Missing args");
  assert(!state.sites[siteName], "Site already exists");
  if (deployFolder.startsWith("~/")) deployFolder = deployFolder.slice(2);
  if (deployFolder.endsWith("/")) deployFolder = deployFolder.slice(0, -1);
  const operatingSystem = await getOperatingSystem(hostName);

  const site: Site = {
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
  stateChange$.next({op: "add", path: `/sites/${siteName}`, value: site});
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

async function getDeployedServices(site: Site): Promise<{[key: string]: Service}> {
  const commands = config.commands[site.operatingSystem];
  let output = await ssh(site.hostName, interpolate(commands.listServices, {deployFolder: site.deployFolder}));
  output.stdout = output.stdout.trim();
  const serviceNames = output.stdout ? output.stdout.split(/\s+/) : [];
  const services: {[key: string]: Service} = {};

  for (const serviceName of serviceNames) {
    const envInfo = await readServiceConf(site, serviceName);
    assert(envInfo.REPO_URL, "Missing env REPO_URL for service " + serviceName)
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


function removeSite(siteName: string): void {
  assert(siteName, "Missing args");
  assert(state.sites[siteName], "Site not found");
  assert(!isSiteActive(state.sites[siteName]), "Site active");

  delete state.sites[siteName];
  stateChange$.next({op: "remove", path: `/sites/${siteName}`});
}

function isSiteActive(site: Site): boolean {
  return Object.values(site.services).some(x => x.status != ServiceStatus.STOPPED)
    || Object.values(site.tunnels).length > 0
}


async function deployService(siteName: string, serviceName: string, repoUrl: string, repoTag: string|undefined): Promise<Message> {
  assert(siteName && serviceName && repoUrl, "Missing args");
  const site = state.sites[siteName];
  assert(site, "Site not found");
  assert(!site.services[serviceName], "Service exists");

  const commands = config.commands[site.operatingSystem];
  let output = await ssh(site.hostName, interpolate(commands.deployService, {
    deployFolder: site.deployFolder,
    serviceName,
    repoUrl,
    repoTag: repoTag || "master"
  }))
  await writeServiceConf(site, serviceName, {
    REPO_URL: repoUrl,
    REPO_TAG: repoTag,
    SERVICE_BROKER_URL: site.serviceBrokerUrl,
    SITE_NAME: siteName,
    SERVICE_NAME: serviceName,
  })
  site.services[serviceName] = {
    serviceName,
    repoUrl,
    repoTag,
    status: ServiceStatus.STOPPED
  };
  stateChange$.next({op: "add", path: `/sites/${siteName}/services/${serviceName}`, value: site.services[serviceName]});
  return {payload: JSON.stringify(output)};
}

async function readServiceConf(site: Site, serviceName: string): Promise<{[name: string]: string|undefined}> {
  const commands = config.commands[site.operatingSystem];
  const output = await ssh(site.hostName, interpolate(commands.readServiceConf, {deployFolder: site.deployFolder, serviceName}));
  return dotenv.parse(output.stdout);
}

async function writeServiceConf(site: Site, serviceName: string, props: {[name: string]: string|undefined}): Promise<void> {
  const file = await new Promise<string>((fulfill, reject) => tmpName((err, path) => err ? reject(err) : fulfill(path)))
  const text = Object.keys(props)
    .filter(name => props[name] != undefined)
    .map(name => `${name}=${props[name]}`)
    .join('\n')
  await promisify(fs.writeFile)(file, text);
  await scp(file, `${site.hostName}:${site.deployFolder}/${serviceName}/.env`);
  await promisify(fs.unlink)(file);
}


async function undeployService(siteName: string, serviceName: string): Promise<void> {
  assert(siteName && serviceName, "Missing args");
  const site = state.sites[siteName];
  assert(site, "Site not found");
  const service = site.services[serviceName];
  assert(service, "Service not exists");
  assert(service.status == ServiceStatus.STOPPED, "Service not stopped");

  const commands = config.commands[site.operatingSystem];
  await ssh(site.hostName, interpolate(commands.undeployService, {deployFolder: site.deployFolder, serviceName}));
  delete site.services[serviceName];
  stateChange$.next({op: "remove", path: `/sites/${siteName}/services/${serviceName}`});
}


async function startService(siteName: string, serviceName: string): Promise<void> {
  assert(siteName && serviceName, "Missing args");
  const site = state.sites[siteName];
  assert(site, "Site not found");
  const service = site.services[serviceName];
  assert(service, "Service not exists");
  assert(service.status == ServiceStatus.STOPPED, "Service not stopped");

  const commands = config.commands[site.operatingSystem];
  ssh(site.hostName, interpolate(commands.startService, {deployFolder: site.deployFolder, serviceName}))
    .catch(err => "OK")
    .then(() => setStopped(site, service))

  service.status = ServiceStatus.STARTING;
  stateChange$.next({op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status});
}

function setStopped(site: Site, service: Service) {
  if (service.status == ServiceStatus.STOPPED) return;
  service.status = ServiceStatus.STOPPED;
  service.pid = undefined;
  service.endpointId = undefined;
  service.lastCheckedIn = undefined;
  stateChange$.next({op: "replace", path: `/sites/${site.siteName}/services/${service.serviceName}`, value: service});
}


async function stopService(siteName: string, serviceName: string): Promise<void> {
  assert(siteName && serviceName, "Missing args");
  const site = state.sites[siteName];
  assert(site, "Site not found");
  const service = site.services[serviceName];
  assert(service, "Service not exists");
  assert(service.status == ServiceStatus.STARTED, "Service not started");
  assert(service.endpointId, "FATAL endpointId null");

  await sb.requestTo(service.endpointId, "service-manager-client", {header: {method: "shutdown", pid: service.pid}});
  service.status = ServiceStatus.STOPPING;
  stateChange$.next({op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status});

  waitUntilStopped(site, service, 6);
}

async function waitUntilStopped(site: Site, service: Service, timeout: number): Promise<void> {
  try {
    const commands = config.commands[site.operatingSystem];
    await ssh(site.hostName, interpolate(commands.checkService, {pid: service.pid, timeout}));
  }
  catch (err) {
    setStopped(site, service);
  }
}


async function killService(siteName: string, serviceName: string): Promise<void> {
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
    stateChange$.next({op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status});
  }

  waitUntilStopped(site, service, 3);
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


function setServiceStatus(siteName: string, serviceName: string, newStatus: ServiceStatus): void {
  assert(siteName && serviceName && newStatus, "Missing args");
  const site = state.sites[siteName];
  assert(site, "Site not found");
  const service = site.services[serviceName];
  assert(service, "Service not exists");

  if (service.status != newStatus) {
    service.status = newStatus;
    stateChange$.next({op: "replace", path: `/sites/${siteName}/services/${serviceName}/status`, value: service.status});
  }
}


async function updateService(siteName: string, serviceName: string): Promise<Message> {
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
  }))
  return {payload: JSON.stringify(output)};
}


async function getServiceConf(siteName: string, serviceName: string): Promise<Message> {
  assert(siteName && serviceName, "Missing args");
  const site = state.sites[siteName];
  assert(site, "Site not found");

  const props = await readServiceConf(site, serviceName);
  return {header: {serviceConf: props}};
}

async function updateServiceConf(siteName: string, serviceName: string, serviceConf: {[name: string]: string}): Promise<void> {
  assert(siteName && serviceName, "Missing args");
  const site = state.sites[siteName];
  assert(site, "Site not found");

  await writeServiceConf(site, serviceName, serviceConf);
}


function serviceCheckIn(siteName: string, serviceName: string, pid: string, endpointId: string): void {
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
    stateChange$.next({op: "replace", path: `/sites/${siteName}/services/${serviceName}`, value: service});
  }
}


async function addTopic(topicName: string, historySize: number): Promise<void> {
  assert(topicName && historySize, "Missing args");
  assert(!state.topics[topicName], "Topic already exists");

  const topic = {topicName, historySize};
  await sb.subscribe(topic.topicName, (text: string) => onTopicMessage(topic, text));

  state.topics[topicName] = topic;
  stateChange$.next({op: "add", path: `/topics/${topicName}`, value: state.topics[topicName]});
}

async function removeTopic(topicName: string): Promise<void> {
  assert(topicName, "Missing args");
  assert(state.topics[topicName], "Topic not exists");

  await sb.unsubscribe(topicName);

  delete state.topics[topicName];
  stateChange$.next({op: "remove", path: `/topics/${topicName}`});
}

function subscribeTopic(client: Client, topicName: string): Message {
  assert(client && topicName, "Missing args");
  const topic = state.topics[topicName];
  assert(topic, "Topic not found");

  client.viewTopic = topicName;
  return {payload: JSON.stringify(topicHistory[topicName] || [])};
}

function unsubscribeTopic(client: Client): void {
  client.viewTopic = undefined;
}

function onTopicMessage(topic: Topic, text: string) {
  const history = topicHistory[topic.topicName] || (topicHistory[topic.topicName] = []);
  history.push(text);
  if (history.length > topic.historySize) history.shift();

  Object.values(clients).forEach(client => {
    if (client.viewTopic == topic.topicName)
      sb.notifyTo(client.endpointId, "service-manager-client", {header: {method: "onTopicMessage"}, payload: text});
  })
}


function addTunnel(siteName: unknown, fromPort: unknown, toHost: unknown, toPort: unknown) {
  assert(
    typeof siteName == "string"
    && typeof fromPort == "number"
    && typeof toHost == "string"
    && typeof toPort == "number", "Bad args"
  )
  const site = state.sites[siteName]
  assert(site, "Site not found")
  assert(!site.tunnels[fromPort], "Tunnel exists")

  site.tunnels[fromPort] = {toHost, toPort}
  stateChange$.next({op: "add", path: `/sites/${siteName}/tunnels/${fromPort}`, value: site.tunnels[fromPort]})
  createTunnel(site.hostName, fromPort, toHost, toPort)
}

function removeTunnel(siteName: unknown, fromPort: unknown) {
  assert(
    typeof siteName == "string"
    && typeof fromPort == "number", "Bad args"
  )
  const site = state.sites[siteName]
  assert(site, "Site not found")
  assert(site.tunnels[fromPort], "Tunnel not exists")

  delete site.tunnels[fromPort]
  stateChange$.next({op: "remove", path: `/sites/${siteName}/tunnels/${fromPort}`})
  destroyTunnel(site.hostName, fromPort)
}
