import sb from "./service-broker"

afterAll(() => {
  sb.shutdown()
});


test("pub/sub", async () => {
  const queue = new Queue();
  sb.subscribe("test-log", msg => queue.push(msg));

  sb.publish("test-log", "what in the world");
  expect(await queue.shift()).toBe("what in the world");
});


test("request/response", async () => {
  const queue = new Queue();
  sb.advertise({name:"test-tts", capabilities:["v1","v2"], priority:1}, msg => {
    queue.push(msg);
    return {
      header: {result:1},
      payload: Buffer.from("this is response payload")
    };
  });

  let promise = sb.request({name:"test-tts", capabilities:["v1"]}, {
    header: {lang:"vi"},
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
  sb.setServiceHandler("test-direct", msg => {
    queue.push(msg);
    return {
      header: {output: "crap"},
      payload: Buffer.from("Direct response payload")
    };
  });
  promise = sb.requestTo(endpointId, "test-direct", {
    header: {value: 100},
    payload: "Direct request payload"
  });
  expect(await queue.shift()).toEqual({
    header: {
      ip: expect.any(String),
      to: endpointId,
      from: expect.any(String),
      id: expect.any(String),
      type: "ServiceRequest",
      service: {name: "test-direct"},
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
  sb.notifyTo(endpointId, "test-direct", {
    header: {value: 200},
    payload: Buffer.from("Direct notify payload")
  });
  expect(await queue.shift()).toEqual({
    header: {
      ip: expect.any(String),
      to: endpointId,
      from: expect.any(String),
      type: "ServiceRequest",
      service: {name: "test-direct"},
      value: 200
    },
    payload: Buffer.from("Direct notify payload")
  });

  //test no-provider
  try {
    await sb.request({name:"test-tts", capabilities:["v3"]}, {
      header: {lang:"en"},
      payload: "this is request payload"
    });
  }
  catch (err) {
    expect(err.message).toMatch("No provider");
  }
});


class Queue<T> {
  items: T[];
  waiters: Array<{fulfill: (item: T) => void}>;
  constructor() {
    this.items = [];
    this.waiters = [];
  }
  push(value: T) {
    this.items.push(value);
    while (this.items.length && this.waiters.length) this.waiters.shift().fulfill(this.items.shift());
  }
  shift(): T|Promise<T> {
    if (this.items.length) return this.items.shift();
    else return new Promise(fulfill => this.waiters.push({fulfill}));
  }
}
