"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const service_broker_1 = require("./service-broker");
const service_manager_1 = require("./service-manager");
afterAll(service_manager_1.shutdown);
test("pub/sub", async () => {
    const queue = new Queue();
    service_broker_1.default.subscribe("test-log", msg => queue.push(msg));
    service_broker_1.default.publish("test-log", "what in the world");
    expect(await queue.shift()).toBe("what in the world");
});
test("request/response", async () => {
    const queue = new Queue();
    service_broker_1.default.advertise({ name: "test-tts", capabilities: ["v1", "v2"], priority: 1 }, msg => {
        queue.push(msg);
        return {
            header: { result: 1 },
            payload: Buffer.from("this is response payload")
        };
    });
    let promise = service_broker_1.default.request({ name: "test-tts", capabilities: ["v1"] }, {
        header: { lang: "vi" },
        payload: "this is request payload"
    });
    expect(await queue.shift()).toEqual({
        header: {
            ip: expect.any(String),
            from: expect.any(String),
            id: expect.any(String),
            type: "ServiceRequest",
            service: {
                name: "test-tts",
                capabilities: ["v1"]
            },
            lang: "vi"
        },
        payload: "this is request payload"
    });
    let res = await promise;
    expect(res).toEqual({
        header: {
            from: expect.any(String),
            to: expect.any(String),
            id: expect.any(String),
            type: "ServiceResponse",
            result: 1
        },
        payload: Buffer.from("this is response payload")
    });
    //test setServiceHandler, requestTo, notifyTo
    const endpointId = res.header.from;
    service_broker_1.default.setServiceHandler("test-direct", msg => {
        queue.push(msg);
        return {
            header: { output: "crap" },
            payload: Buffer.from("Direct response payload")
        };
    });
    promise = service_broker_1.default.requestTo(endpointId, "test-direct", {
        header: { value: 100 },
        payload: "Direct request payload"
    });
    expect(await queue.shift()).toEqual({
        header: {
            to: endpointId,
            from: expect.any(String),
            id: expect.any(String),
            type: "ServiceRequest",
            service: { name: "test-direct" },
            value: 100
        },
        payload: "Direct request payload"
    });
    expect(await promise).toEqual({
        header: {
            from: expect.any(String),
            to: expect.any(String),
            id: expect.any(String),
            type: "ServiceResponse",
            output: "crap"
        },
        payload: Buffer.from("Direct response payload")
    });
    service_broker_1.default.notifyTo(endpointId, "test-direct", {
        header: { value: 200 },
        payload: Buffer.from("Direct notify payload")
    });
    expect(await queue.shift()).toEqual({
        header: {
            to: endpointId,
            from: expect.any(String),
            type: "ServiceRequest",
            service: { name: "test-direct" },
            value: 200
        },
        payload: Buffer.from("Direct notify payload")
    });
    //test no-provider
    try {
        await service_broker_1.default.request({ name: "test-tts", capabilities: ["v3"] }, {
            header: { lang: "en" },
            payload: "this is request payload"
        });
    }
    catch (err) {
        expect(err.message).toMatch("No provider");
    }
});
class Queue {
    constructor() {
        this.items = [];
        this.waiters = [];
    }
    push(value) {
        this.items.push(value);
        while (this.items.length && this.waiters.length)
            this.waiters.shift().fulfill(this.items.shift());
    }
    shift() {
        if (this.items.length)
            return this.items.shift();
        else
            return new Promise(fulfill => this.waiters.push({ fulfill }));
    }
}
