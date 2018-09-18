import { Readable, PassThrough, Transform } from "stream"
import * as WebSocket from "ws"
import * as pTimeout from "p-timeout"
import config from "../config"
import Iterator from "./iterator"
import logger from "./logger"



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




if (!config.serviceBrokerUrl) throw new Error("Missing serviceBrokerUrl");

const providers: {[key: string]: Provider} = {};
const pending: {[key: string]: PendingResponse} = {};
let pendingIdGen = 0;
const getConnection = new Iterator(connect).throttle(15000).keepWhile(con => con && !con.isClosed).noRace().next;
let shutdownFlag: boolean = false;



async function connect(): Promise<Connection> {
  try {
    const ws = new WebSocket(config.serviceBrokerUrl) as Connection;
    await new Promise(function(fulfill, reject) {
      ws.once("error", reject);
      ws.once("open", () => {
        ws.removeListener("error", reject);
        fulfill();
      });
    });
    logger.info("Service broker connection established");
    ws.on("message", onMessage);
    ws.on("error", logger.error);
    ws.once("close", function(code, reason) {
      ws.isClosed = true;
      if (!shutdownFlag) {
        logger.error("Service broker connection lost,", code, reason||"");
        getConnection();
      }
    });
    ws.send(JSON.stringify({
      type: "SbAdvertiseRequest",
      services: Object.values(providers).filter(x => x.advertise).map(x => x.service)
    }));
    return ws;
  }
  catch (err) {
    logger.error("Failed to connect to service broker,", err.message);
    return null;
  }
}

function onMessage(data: string|Buffer) {
  let msg;
  try {
    if (typeof data == "string") msg = messageFromString(data);
    else if (Buffer.isBuffer(data)) msg = messageFromBuffer(data);
    else throw new Error("Message is not a string or Buffer");
  }
  catch (err) {
    logger.error(err.message);
    return;
  }
  if (msg.header.type == "ServiceRequest") onServiceRequest(msg);
  else if (msg.header.type == "ServiceResponse") onServiceResponse(msg);
  else if (msg.header.type == "SbStatusResponse") onServiceResponse(msg);
  else if (msg.header.error) onServiceResponse(msg);
  else logger.error("Don't know what to do with message:", msg.header);
}

async function onServiceRequest(msg: Message) {
  try {
    if (providers[msg.header.service.name]) {
      const res = await providers[msg.header.service.name].handler(msg) || {};
      if (msg.header.id) {
        const header = {
          to: msg.header.from,
          id: msg.header.id,
          type: "ServiceResponse"
        };
        await send(Object.assign({}, res.header, header), res.payload);
      }
    }
    else throw new Error("No provider for service " + msg.header.service.name);
  }
  catch (err) {
    if (msg.header.id) {
      await send({
        to: msg.header.from,
        id: msg.header.id,
        type: "ServiceResponse",
        error: err.message
      });
    }
    else logger.error(err.message, msg.header);
  }
}

function onServiceResponse(msg: Message) {
  if (pending[msg.header.id]) pending[msg.header.id].process(msg);
  else logger.error("Response received but no pending request:", msg.header);
}

function messageFromString(str: string): Message {
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

function messageFromBuffer(buf: Buffer) {
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

async function send(header: {[key: string]: any}, payload?: string|Buffer|Readable) {
  const ws = await getConnection();
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
      const stream = packetizer(64*1000);
      stream.on("data", data => send(Object.assign({}, header, {part:true}), data));
      stream.on("end", () => send(header));
      payload.pipe(stream);
    }
    else throw new Error("Unexpected");
  }
  else ws.send(headerStr);
}

function packetizer(size: number): Transform {
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




export async function advertise(service: {name: string, capabilities?: string[], priority?: number}, handler: (msg: Message) => Message|Promise<Message>) {
  if (providers[service.name]) throw new Error(`${service.name} provider already exists`);
  providers[service.name] = {
    service,
    handler,
    advertise: true
  };
  await send({
    type: "SbAdvertiseRequest",
    services: Object.values(providers).filter(x => x.advertise).map(x => x.service)
  });
}

export async function unadvertise(serviceName: string) {
  if (!providers[serviceName]) throw new Error(`${serviceName} provider not exists`);
  delete providers[serviceName];
  await send({
    type: "SbAdvertiseRequest",
    services: Object.values(providers).filter(x => x.advertise).map(x => x.service)
  });
}

export function setServiceHandler(serviceName: string, handler: (msg: Message) => Message|Promise<Message>) {
  if (providers[serviceName]) throw new Error(`${serviceName} provider already exists`);
  providers[serviceName] = {
    service: {name: serviceName},
    handler,
    advertise: false
  };
}



export async function request(service: {name: string, capabilities?: string[]}, req: Message, timeout?: number): Promise<Message> {
  if (!req) req = {};
  const id = String(++pendingIdGen);
  const promise = pendingResponse(id, timeout);
  const header = {
    id,
    type: "ServiceRequest",
    service
  };
  await send(Object.assign({}, req.header, header), req.payload);
  return promise;
}

export async function notify(service: {name: string, capabilities?: string[]}, msg: Message): Promise<void> {
  if (!msg) msg = {};
  const header = {
    type: "ServiceRequest",
    service
  };
  await send(Object.assign({}, msg.header, header), msg.payload);
}

export async function requestTo(endpointId: string, serviceName: string, req: Message, timeout?: number): Promise<Message> {
  if (!req) req = {};
  const id = String(++pendingIdGen);
  const promise = pendingResponse(id, timeout);
  const header = {
    to: endpointId,
    id,
    type: "ServiceRequest",
    service: {name: serviceName}
  }
  await send(Object.assign({}, req.header, header), req.payload);
  return promise;
}

export async function notifyTo(endpointId: string, serviceName: string, msg: Message): Promise<void> {
  if (!msg) msg = {};
  const header = {
    to: endpointId,
    type: "ServiceRequest",
    service: {name: serviceName}
  }
  await send(Object.assign({}, msg.header, header), msg.payload);
}

function pendingResponse(id: string, timeout?: number): Promise<Message> {
  const promise: Promise<Message> = new Promise(function(fulfill, reject) {
    pending[id] = {
      process: function(res) {
        if (res.header.error) {
          delete pending[id];
          reject(new Error(res.header.error));
        }
        else {
          if (res.header.part) {
            if (!this.stream) fulfill({header: res.header, payload: this.stream = new PassThrough()});
            this.stream.write(res.payload);
          }
          else {
            delete pending[id];
            if (this.stream) this.stream.end(res.payload);
            else fulfill(res);
          }
        }
      }
    };
  });
  return pTimeout(promise, timeout || 30*1000)
    .catch(err => {
      delete pending[id];
      throw err;
    });
}




export async function publish(topic: string, text: string) {
  await send({
    type: "ServiceRequest",
    service: {name: "#"+topic}
  },
  text);
}

export async function subscribe(topic: string, handler: (text: string) => void) {
  await advertise({name: "#"+topic}, (msg: Message) => {
    handler(msg.payload as string);
    return null;
  });
}

export async function unsubscribe(topic: string) {
  await unadvertise("#"+topic);
}




export async function status() {
  const id = String(++pendingIdGen);
  const promise = pendingResponse(id);
  await send({
    id,
    type: "SbStatusRequest"
  });
  return promise.then(res => JSON.parse(res.payload as string));
}

export async function shutdown() {
  shutdownFlag = true;
  const ws = await getConnection();
  ws.close();
}
