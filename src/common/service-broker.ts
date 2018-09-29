import * as pTimeout from "p-timeout";
import { PassThrough, Readable, Transform } from "stream";
import * as WebSocket from "ws";
import config from "../config";
import Iterator from "./iterator";
import logger from "./logger";
import * as assert from "assert";


export interface Message {
  header?: {[key: string]: any};
  payload?: string|Buffer|Readable;
}

type Provider = {
  service: {
    name: string;
    capabilities?: string[];
    priority?: number;
  };
  handler: (msg: Message) => Message|Promise<Message>;
  advertise: boolean;
};

type PendingResponse = {
  process: (msg: Message) => void;
};

type Connection = WebSocket & {isClosed: boolean};

const reservedFields: {[key: string]: void} = {
  from: undefined,
  to: undefined,
  id: undefined,
  type: undefined,
  error: undefined,
  service: undefined,
  part: undefined
};




export class ServiceBroker {
  private readonly providers: {[key: string]: Provider};
  private readonly pending: {[key: string]: PendingResponse};
  private pendingIdGen: number;
  private readonly getConnection: () => Connection|Promise<Connection>;
  private shutdownFlag: boolean;

  constructor(private url: string) {
    assert(url, "Missing args");
    this.providers = {};
    this.pending = {};
    this.pendingIdGen = 0;
    this.getConnection = new Iterator(() => this.connect()).throttle(15000).keepWhile(con => con && !con.isClosed).noRace().next;
    this.shutdownFlag = false;
  }

private async connect(): Promise<Connection> {
  try {
    const ws = new WebSocket(this.url) as Connection;
    await new Promise(function(fulfill, reject) {
      ws.once("error", reject);
      ws.once("open", () => {
        ws.removeListener("error", reject);
        fulfill();
      });
    });
    logger.info("Service broker connection established");
    ws.on("message", (data: string|Buffer) => this.onMessage(data));
    ws.on("error", logger.error);
    ws.once("close", (code, reason) => {
      ws.isClosed = true;
      if (!this.shutdownFlag) {
        logger.error("Service broker connection lost,", code, reason||"");
        this.getConnection();
      }
    });
    ws.send(JSON.stringify({
      type: "SbAdvertiseRequest",
      services: Object.values(this.providers).filter(x => x.advertise).map(x => x.service)
    }));
    return ws;
  }
  catch (err) {
    logger.error("Failed to connect to service broker,", err.message);
    return null;
  }
}

private onMessage(data: string|Buffer) {
  let msg;
  try {
    if (typeof data == "string") msg = this.messageFromString(data);
    else if (Buffer.isBuffer(data)) msg = this.messageFromBuffer(data);
    else throw new Error("Message is not a string or Buffer");
  }
  catch (err) {
    logger.error(err.message);
    return;
  }
  if (msg.header.type == "ServiceRequest") this.onServiceRequest(msg);
  else if (msg.header.type == "ServiceResponse") this.onServiceResponse(msg);
  else if (msg.header.type == "SbStatusResponse") this.onServiceResponse(msg);
  else if (msg.header.error) this.onServiceResponse(msg);
  else if (msg.header.service) this.onServiceRequest(msg);
  else logger.error("Don't know what to do with message:", msg.header);
}

private async onServiceRequest(msg: Message) {
  try {
    if (this.providers[msg.header.service.name]) {
      const res = await this.providers[msg.header.service.name].handler(msg) || {};
      if (msg.header.id) {
        const header = {
          to: msg.header.from,
          id: msg.header.id,
          type: "ServiceResponse"
        };
        await this.send(Object.assign({}, res.header, reservedFields, header), res.payload);
      }
    }
    else throw new Error("No provider for service " + msg.header.service.name);
  }
  catch (err) {
    if (msg.header.id) {
      await this.send({
        to: msg.header.from,
        id: msg.header.id,
        type: "ServiceResponse",
        error: err.message
      });
    }
    else logger.error(err.message, msg.header);
  }
}

private onServiceResponse(msg: Message) {
  if (this.pending[msg.header.id]) this.pending[msg.header.id].process(msg);
  else logger.error("Response received but no pending request:", msg.header);
}

private messageFromString(str: string): Message {
  if (str[0] != "{") throw new Error("Message doesn't have JSON header");
  const index = str.indexOf("\n");
  const headerStr = (index != -1) ? str.slice(0,index) : str;
  const payload = (index != -1) ? str.slice(index+1) : undefined;
  let header;
  try {
    header = JSON.parse(headerStr);
  }
  catch (err) {
    throw new Error("Failed to parse message header");
  }
  return {header, payload};
}

private messageFromBuffer(buf: Buffer) {
  if (buf[0] != 123) throw new Error("Message doesn't have JSON header");
  const index = buf.indexOf("\n");
  const headerStr = (index != -1) ? buf.slice(0,index).toString() : buf.toString();
  const payload = (index != -1) ? buf.slice(index+1) : undefined;
  let header;
  try {
    header = JSON.parse(headerStr);
  }
  catch (err) {
    throw new Error("Failed to parse message header");
  }
  return {header, payload};
}

private async send(header: {[key: string]: any}, payload?: string|Buffer|Readable) {
  const ws = await this.getConnection();
  const headerStr = JSON.stringify(header);
  if (payload) {
    if (typeof payload == "string") {
      ws.send(headerStr + "\n" + payload);
    }
    else if (Buffer.isBuffer(payload)) {
      const headerLen = Buffer.byteLength(headerStr);
      const tmp = Buffer.allocUnsafe(headerLen +1 +payload.length);
      tmp.write(headerStr);
      tmp[headerLen] = 10;
      payload.copy(tmp, headerLen+1);
      ws.send(tmp);
    }
    else if (payload.pipe) {
      const stream = this.packetizer(64*1000);
      stream.on("data", data => this.send(Object.assign({}, header, {part:true}), data));
      stream.on("end", () => this.send(header));
      payload.pipe(stream);
    }
    else throw new Error("Unexpected");
  }
  else ws.send(headerStr);
}

private packetizer(size: number): Transform {
  let buf: Buffer;
  let pos: number;
  return new Transform({
    transform: function(chunk: Buffer, encoding, callback) {
      while (chunk.length) {
        if (!buf) {
          buf = Buffer.alloc(size);
          pos = 0;
        }
        const count = chunk.copy(buf, pos);
        pos += count;
        if (pos >= buf.length) {
          this.push(buf);
          buf = null;
        }
        chunk = chunk.slice(count);
      }
      callback();
    },
    flush: function(callback) {
      if (buf) {
        this.push(buf.slice(0, pos));
        buf = null;
      }
      callback();
    }
  });
}




async advertise(service: {name: string, capabilities?: string[], priority?: number}, handler: (msg: Message) => Message|Promise<Message>) {
  assert(service && service.name && handler, "Missing args");
  assert(!this.providers[service.name], `${service.name} provider already exists`);
  this.providers[service.name] = {
    service,
    handler,
    advertise: true
  };
  await this.send({
    type: "SbAdvertiseRequest",
    services: Object.values(this.providers).filter(x => x.advertise).map(x => x.service)
  });
}

async unadvertise(serviceName: string) {
  assert(serviceName, "Missing args");
  assert(this.providers[serviceName], `${serviceName} provider not exists`);
  delete this.providers[serviceName];
  await this.send({
    type: "SbAdvertiseRequest",
    services: Object.values(this.providers).filter(x => x.advertise).map(x => x.service)
  });
}

setServiceHandler(serviceName: string, handler: (msg: Message) => Message|Promise<Message>) {
  assert(serviceName && handler, "Missing args");
  assert(!this.providers[serviceName], `${serviceName} provider already exists`);
  this.providers[serviceName] = {
    service: {name: serviceName},
    handler,
    advertise: false
  };
}



async request(service: {name: string, capabilities?: string[]}, req: Message, timeout?: number): Promise<Message> {
  assert(service && service.name && req, "Missing args");
  if (!req) req = {};
  const id = String(++this.pendingIdGen);
  const promise = this.pendingResponse(id, timeout);
  const header = {
    id,
    type: "ServiceRequest",
    service
  };
  await this.send(Object.assign({}, req.header, reservedFields, header), req.payload);
  return promise;
}

async notify(service: {name: string, capabilities?: string[]}, msg: Message): Promise<void> {
  assert(service && service.name && msg, "Missing args");
  if (!msg) msg = {};
  const header = {
    type: "ServiceRequest",
    service
  };
  await this.send(Object.assign({}, msg.header, reservedFields, header), msg.payload);
}

async requestTo(endpointId: string, serviceName: string, req: Message, timeout?: number): Promise<Message> {
  assert(endpointId && serviceName && req, "Missing args");
  if (!req) req = {};
  const id = String(++this.pendingIdGen);
  const promise = this.pendingResponse(id, timeout);
  const header = {
    to: endpointId,
    id,
    type: "ServiceRequest",
    service: {name: serviceName}
  }
  await this.send(Object.assign({}, req.header, reservedFields, header), req.payload);
  return promise;
}

async notifyTo(endpointId: string, serviceName: string, msg: Message): Promise<void> {
  assert(endpointId && serviceName && msg, "Missing args");
  if (!msg) msg = {};
  const header = {
    to: endpointId,
    type: "ServiceRequest",
    service: {name: serviceName}
  }
  await this.send(Object.assign({}, msg.header, reservedFields, header), msg.payload);
}

private pendingResponse(id: string, timeout?: number): Promise<Message> {
  const promise: Promise<Message> = new Promise((fulfill, reject) => {
    let stream: PassThrough;
    this.pending[id] = {
      process: res => {
        if (res.header.error) reject(new Error(res.header.error));
        else {
          if (res.header.part) {
            if (!stream) fulfill({header: res.header, payload: stream = new PassThrough()});
            stream.write(res.payload);
          }
          else {
            delete this.pending[id];
            if (stream) stream.end(res.payload);
            else fulfill(res);
          }
        }
      }
    };
  });
  return pTimeout(promise, timeout || 30*1000)
    .catch(err => {
      delete this.pending[id];
      throw err;
    });
}




async publish(topic: string, text: string) {
  assert(topic && text, "Missing args");
  await this.send({
    type: "ServiceRequest",
    service: {name: "#"+topic}
  },
  text);
}

async subscribe(topic: string, handler: (text: string) => void) {
  assert(topic && handler, "Missing args");
  await this.advertise({name: "#"+topic}, (msg: Message) => {
    handler(msg.payload as string);
    return null;
  });
}

async unsubscribe(topic: string) {
  assert(topic, "Missing args");
  await this.unadvertise("#"+topic);
}




async status() {
  const id = String(++this.pendingIdGen);
  const promise = this.pendingResponse(id);
  await this.send({
    id,
    type: "SbStatusRequest"
  });
  return promise.then(res => JSON.parse(res.payload as string));
}

async shutdown() {
  this.shutdownFlag = true;
  const ws = await this.getConnection();
  ws.close();
}
}



assert(config.serviceBrokerUrl, "Missing config serviceBrokerUrl");
const defaultServiceBroker = new ServiceBroker(config.serviceBrokerUrl);
export default defaultServiceBroker;
