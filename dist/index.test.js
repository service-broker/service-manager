"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const service_broker_1 = require("./common/service-broker");
require("./index");
afterAll(() => service_broker_1.default.shutdown());
test("test only", async () => {
    const res = await service_broker_1.default.request({ name: "service-manager" }, { header: { method: "listServices", siteName: "jupiter" } });
    console.log(res.header);
});
