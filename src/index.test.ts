import { request, Message, shutdown } from "./common/service-broker"

beforeAll(() => {
  require("./index");
})

afterAll(() => {
  return shutdown();
})


test("test only", async () => {
  const res = await request({name: "service-manager"}, {header: {method: "listServices", siteName: "jupiter"}});
  console.log(res.header);
})
