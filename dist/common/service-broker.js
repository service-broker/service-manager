"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const stream_1 = require("stream");
const WebSocket = require("ws");
const pTimeout = require("p-timeout");
const config_1 = require("../config");
const iterator_1 = require("./iterator");
const logger_1 = require("./logger");
if (!config_1.default.serviceBrokerUrl)
    throw new Error("Missing serviceBrokerUrl");
const providers = {};
const pending = {};
let pendingIdGen = 0;
const getConnection = new iterator_1.default(connect).throttle(15000).keepWhile(con => con && !con.isClosed).noRace().next;
let shutdownFlag = false;
async function connect() {
    try {
        const ws = new WebSocket(config_1.default.serviceBrokerUrl);
        await new Promise(function (fulfill, reject) {
            ws.once("error", reject);
            ws.once("open", () => {
                ws.removeListener("error", reject);
                fulfill();
            });
        });
        logger_1.default.info("Service broker connection established");
        ws.on("message", onMessage);
        ws.on("error", logger_1.default.error);
        ws.once("close", function (code, reason) {
            ws.isClosed = true;
            if (!shutdownFlag) {
                logger_1.default.error("Service broker connection lost,", code, reason || "");
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
        logger_1.default.error("Failed to connect to service broker,", err.message);
        return null;
    }
}
function onMessage(data) {
    let msg;
    try {
        if (typeof data == "string")
            msg = messageFromString(data);
        else if (Buffer.isBuffer(data))
            msg = messageFromBuffer(data);
        else
            throw new Error("Message is not a string or Buffer");
    }
    catch (err) {
        logger_1.default.error(err.message);
        return;
    }
    if (msg.header.type == "ServiceRequest")
        onServiceRequest(msg);
    else if (msg.header.type == "ServiceResponse")
        onServiceResponse(msg);
    else if (msg.header.type == "SbStatusResponse")
        onServiceResponse(msg);
    else if (msg.header.error)
        onServiceResponse(msg);
    else
        logger_1.default.error("Don't know what to do with message:", msg.header);
}
async function onServiceRequest(msg) {
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
        else
            throw new Error("No provider for service " + msg.header.service.name);
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
        else
            logger_1.default.error(err.message, msg.header);
    }
}
function onServiceResponse(msg) {
    if (pending[msg.header.id])
        pending[msg.header.id].process(msg);
    else
        logger_1.default.error("Response received but no pending request:", msg.header);
}
function messageFromString(str) {
    if (str[0] != "{")
        throw new Error("Message doesn't have JSON header");
    const index = str.indexOf("\n");
    const headerStr = (index != -1) ? str.slice(0, index) : str;
    const payload = (index != -1) ? str.slice(index + 1) : undefined;
    let header;
    try {
        header = JSON.parse(headerStr);
    }
    catch (err) {
        throw new Error("Failed to parse message header");
    }
    return { header, payload };
}
function messageFromBuffer(buf) {
    if (buf[0] != 123)
        throw new Error("Message doesn't have JSON header");
    const index = buf.indexOf("\n");
    const headerStr = (index != -1) ? buf.slice(0, index).toString() : buf.toString();
    const payload = (index != -1) ? buf.slice(index + 1) : undefined;
    let header;
    try {
        header = JSON.parse(headerStr);
    }
    catch (err) {
        throw new Error("Failed to parse message header");
    }
    return { header, payload };
}
async function send(header, payload) {
    const ws = await getConnection();
    const headerStr = JSON.stringify(header);
    if (payload) {
        if (typeof payload == "string") {
            ws.send(headerStr + "\n" + payload);
        }
        else if (Buffer.isBuffer(payload)) {
            const headerLen = Buffer.byteLength(headerStr);
            const tmp = Buffer.allocUnsafe(headerLen + 1 + payload.length);
            tmp.write(headerStr);
            tmp[headerLen] = 10;
            payload.copy(tmp, headerLen + 1);
            ws.send(tmp);
        }
        else if (payload.pipe) {
            const stream = packetizer(64 * 1000);
            stream.on("data", data => send(Object.assign({}, header, { part: true }), data));
            stream.on("end", () => send(header));
            payload.pipe(stream);
        }
        else
            throw new Error("Unexpected");
    }
    else
        ws.send(headerStr);
}
function packetizer(size) {
    let buf;
    let pos;
    return new stream_1.Transform({
        transform: function (chunk, encoding, callback) {
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
        flush: function (callback) {
            if (buf) {
                this.push(buf.slice(0, pos));
                buf = null;
            }
            callback();
        }
    });
}
async function advertise(service, handler) {
    if (providers[service.name])
        throw new Error(`${service.name} provider already exists`);
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
exports.advertise = advertise;
async function unadvertise(serviceName) {
    if (!providers[serviceName])
        throw new Error(`${serviceName} provider not exists`);
    delete providers[serviceName];
    await send({
        type: "SbAdvertiseRequest",
        services: Object.values(providers).filter(x => x.advertise).map(x => x.service)
    });
}
exports.unadvertise = unadvertise;
function setServiceHandler(serviceName, handler) {
    if (providers[serviceName])
        throw new Error(`${serviceName} provider already exists`);
    providers[serviceName] = {
        service: { name: serviceName },
        handler,
        advertise: false
    };
}
exports.setServiceHandler = setServiceHandler;
async function request(service, req, timeout) {
    if (!req)
        req = {};
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
exports.request = request;
async function notify(service, msg) {
    if (!msg)
        msg = {};
    const header = {
        type: "ServiceRequest",
        service
    };
    await send(Object.assign({}, msg.header, header), msg.payload);
}
exports.notify = notify;
async function requestTo(endpointId, serviceName, req, timeout) {
    if (!req)
        req = {};
    const id = String(++pendingIdGen);
    const promise = pendingResponse(id, timeout);
    const header = {
        to: endpointId,
        id,
        type: "ServiceRequest",
        service: { name: serviceName }
    };
    await send(Object.assign({}, req.header, header), req.payload);
    return promise;
}
exports.requestTo = requestTo;
async function notifyTo(endpointId, serviceName, msg) {
    if (!msg)
        msg = {};
    const header = {
        to: endpointId,
        type: "ServiceRequest",
        service: { name: serviceName }
    };
    await send(Object.assign({}, msg.header, header), msg.payload);
}
exports.notifyTo = notifyTo;
function pendingResponse(id, timeout) {
    const promise = new Promise(function (fulfill, reject) {
        pending[id] = {
            process: function (res) {
                if (res.header.error) {
                    delete pending[id];
                    reject(new Error(res.header.error));
                }
                else {
                    if (res.header.part) {
                        if (!this.stream)
                            fulfill({ header: res.header, payload: this.stream = new stream_1.PassThrough() });
                        this.stream.write(res.payload);
                    }
                    else {
                        delete pending[id];
                        if (this.stream)
                            this.stream.end(res.payload);
                        else
                            fulfill(res);
                    }
                }
            }
        };
    });
    return pTimeout(promise, timeout || 30 * 1000)
        .catch(err => {
        delete pending[id];
        throw err;
    });
}
async function publish(topic, text) {
    await send({
        type: "ServiceRequest",
        service: { name: "#" + topic }
    }, text);
}
exports.publish = publish;
async function subscribe(topic, handler) {
    await advertise({ name: "#" + topic }, (msg) => {
        handler(msg.payload);
        return null;
    });
}
exports.subscribe = subscribe;
async function unsubscribe(topic) {
    await unadvertise("#" + topic);
}
exports.unsubscribe = unsubscribe;
async function status() {
    const id = String(++pendingIdGen);
    const promise = pendingResponse(id);
    await send({
        id,
        type: "SbStatusRequest"
    });
    return promise.then(res => JSON.parse(res.payload));
}
exports.status = status;
async function shutdown() {
    shutdownFlag = true;
    const ws = await getConnection();
    ws.close();
}
exports.shutdown = shutdown;
