"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const service_broker_1 = require("./common/service-broker");
beforeAll(() => {
    require("./index");
});
afterAll(() => {
    return service_broker_1.shutdown();
});
test("test only", async () => {
    const res = await service_broker_1.request({ name: "service-manager" }, { header: { method: "listServices", siteName: "jupiter" } });
    console.log(res.header);
});
