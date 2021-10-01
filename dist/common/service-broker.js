"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServiceBroker = void 0;
const p_timeout_1 = require("p-timeout");
const stream_1 = require("stream");
const WebSocket = require("ws");
const config_1 = require("../config");
const iterator_1 = require("./iterator");
const logger_1 = require("./logger");
const assert = require("assert");
const reservedFields = {
    from: undefined,
    to: undefined,
    id: undefined,
    type: undefined,
    error: undefined,
    service: undefined,
    part: undefined
};
class ServiceBroker {
    constructor(url) {
        this.url = url;
        assert(url, "Missing args");
        this.providers = {};
        this.pending = {};
        this.pendingIdGen = 0;
        this.conIter = new iterator_1.default(() => this.connect()).throttle(15000).keepWhile(con => con != null && !con.isClosed).noRace();
        this.shutdownFlag = false;
    }
    async getConnection() {
        const con = await this.conIter.next();
        return con;
    }
    async connect() {
        try {
            const ws = new WebSocket(this.url);
            await new Promise(function (fulfill, reject) {
                ws.once("error", reject);
                ws.once("open", () => {
                    ws.removeListener("error", reject);
                    fulfill();
                });
            });
            logger_1.default.info("Service broker connection established");
            ws.on("message", (data, isBinary) => this.onMessage(isBinary == false ? data.toString() : data));
            ws.on("error", logger_1.default.error);
            ws.once("close", (code, reason) => {
                ws.isClosed = true;
                if (!this.shutdownFlag) {
                    logger_1.default.error("Service broker connection lost,", code, reason ? reason.toString() : "");
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
            logger_1.default.error("Failed to connect to service broker,", String(err));
            return null;
        }
    }
    onMessage(data) {
        let msg;
        try {
            if (typeof data == "string")
                msg = this.messageFromString(data);
            else if (Buffer.isBuffer(data))
                msg = this.messageFromBuffer(data);
            else
                throw new Error("Message is not a string or Buffer");
        }
        catch (err) {
            logger_1.default.error(String(err));
            return;
        }
        if (msg.header.type == "ServiceRequest")
            this.onServiceRequest(msg);
        else if (msg.header.type == "ServiceResponse")
            this.onServiceResponse(msg);
        else if (msg.header.type == "SbStatusResponse")
            this.onServiceResponse(msg);
        else if (msg.header.type == "SbEndpointWaitResponse")
            this.onServiceResponse(msg);
        else if (msg.header.error)
            this.onServiceResponse(msg);
        else if (msg.header.service)
            this.onServiceRequest(msg);
        else
            logger_1.default.error("Don't know what to do with message:", msg.header);
    }
    async onServiceRequest(msg) {
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
            else
                throw new Error("No provider for service " + msg.header.service.name);
        }
        catch (err) {
            if (msg.header.id) {
                await this.send({
                    to: msg.header.from,
                    id: msg.header.id,
                    type: "ServiceResponse",
                    error: String(err)
                });
            }
            else
                logger_1.default.error(String(err), msg.header);
        }
    }
    onServiceResponse(msg) {
        if (this.pending[msg.header.id])
            this.pending[msg.header.id].process(msg);
        else
            logger_1.default.error("Response received but no pending request:", msg.header);
    }
    messageFromString(str) {
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
    messageFromBuffer(buf) {
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
    async send(header, payload) {
        const ws = await this.getConnection();
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
                const stream = this.packetizer(64 * 1000);
                stream.on("data", data => this.send(Object.assign({}, header, { part: true }), data));
                stream.on("end", () => this.send(header));
                payload.pipe(stream);
            }
            else
                throw new Error("Unexpected");
        }
        else
            ws.send(headerStr);
    }
    packetizer(size) {
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
    async advertise(service, handler) {
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
    async unadvertise(serviceName) {
        assert(serviceName, "Missing args");
        assert(this.providers[serviceName], `${serviceName} provider not exists`);
        delete this.providers[serviceName];
        await this.send({
            type: "SbAdvertiseRequest",
            services: Object.values(this.providers).filter(x => x.advertise).map(x => x.service)
        });
    }
    setServiceHandler(serviceName, handler) {
        assert(serviceName && handler, "Missing args");
        assert(!this.providers[serviceName], `${serviceName} provider already exists`);
        this.providers[serviceName] = {
            service: { name: serviceName },
            handler,
            advertise: false
        };
    }
    async request(service, req, timeout) {
        assert(service && service.name && req, "Missing args");
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
    async notify(service, msg) {
        assert(service && service.name && msg, "Missing args");
        const header = {
            type: "ServiceRequest",
            service
        };
        await this.send(Object.assign({}, msg.header, reservedFields, header), msg.payload);
    }
    async requestTo(endpointId, serviceName, req, timeout) {
        assert(endpointId && serviceName && req, "Missing args");
        const id = String(++this.pendingIdGen);
        const promise = this.pendingResponse(id, timeout);
        const header = {
            to: endpointId,
            id,
            type: "ServiceRequest",
            service: { name: serviceName }
        };
        await this.send(Object.assign({}, req.header, reservedFields, header), req.payload);
        return promise;
    }
    async notifyTo(endpointId, serviceName, msg) {
        assert(endpointId && serviceName && msg, "Missing args");
        const header = {
            to: endpointId,
            type: "ServiceRequest",
            service: { name: serviceName }
        };
        await this.send(Object.assign({}, msg.header, reservedFields, header), msg.payload);
    }
    pendingResponse(id, timeout) {
        const promise = new Promise((fulfill, reject) => {
            let stream;
            this.pending[id] = {
                process: res => {
                    if (res.header.error)
                        reject(new Error(res.header.error));
                    else {
                        if (res.header.part) {
                            if (!stream)
                                fulfill({ header: res.header, payload: stream = new stream_1.PassThrough() });
                            stream.write(res.payload);
                        }
                        else {
                            delete this.pending[id];
                            if (stream)
                                stream.end(res.payload);
                            else
                                fulfill(res);
                        }
                    }
                }
            };
        });
        return (0, p_timeout_1.default)(promise, timeout || 30 * 1000)
            .catch(err => {
            delete this.pending[id];
            throw err;
        });
    }
    async publish(topic, text) {
        assert(topic && text, "Missing args");
        await this.send({
            type: "ServiceRequest",
            service: { name: "#" + topic }
        }, text);
    }
    async subscribe(topic, handler) {
        assert(topic && handler, "Missing args");
        await this.advertise({ name: "#" + topic }, (msg) => handler(msg.payload));
    }
    async unsubscribe(topic) {
        assert(topic, "Missing args");
        await this.unadvertise("#" + topic);
    }
    async status() {
        const id = String(++this.pendingIdGen);
        await this.send({ id, type: "SbStatusRequest" });
        const res = await this.pendingResponse(id);
        return JSON.parse(res.payload);
    }
    async waitEndpoint(endpointId) {
        const id = String(++this.pendingIdGen);
        await this.send({ id, type: "SbEndpointWaitRequest", endpointId });
        await this.pendingResponse(id, Infinity);
    }
    async shutdown() {
        this.shutdownFlag = true;
        const ws = await this.getConnection();
        ws.close();
    }
}
exports.ServiceBroker = ServiceBroker;
const defaultServiceBroker = new ServiceBroker(config_1.default.serviceBrokerUrl);
exports.default = defaultServiceBroker;
