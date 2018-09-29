import sb from "./common/service-broker"
import "./index"

afterAll(() => sb.shutdown());


test("test only", async () => {
  const res = await sb.request({name: "service-manager"}, {header: {method: "listServices", siteName: "jupiter"}});
  console.log(res.header);
})
