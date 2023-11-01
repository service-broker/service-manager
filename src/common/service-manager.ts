import { MessageWithHeader } from "@service-broker/service-broker-client";
import config from "../config";
import logger from "./logger";
import sb from "./service-broker";

let checkInTimer: NodeJS.Timeout;
const shutdownHandlers: Array<() => Promise<void>> = [];

sb.setServiceHandler("service-manager-client", onRequest);
if (config.siteName && config.serviceName) checkIn();



function onRequest(req: MessageWithHeader) {
  if (req.header.method == "shutdown") return remoteShutdown(req);
  else throw new Error("Unknown method " + req.header.method);
}

async function remoteShutdown(req: MessageWithHeader) {
  if (req.header.pid != process.pid) throw new Error("pid incorrect");
  await shutdown()
}

export async function shutdown() {
  for (const handler of shutdownHandlers) await handler();
  clearTimeout(checkInTimer);
  await new Promise(f => setTimeout(f, 1000))
  await sb.shutdown()
}

function checkIn() {
  sb.notify({name: "service-manager"}, {
    header: {
      method: "serviceCheckIn",
      args: {
        siteName: config.siteName,
        serviceName: config.serviceName,
        pid: process.pid
      }
    }
  })
  .catch(logger.error)
  .then(() => checkInTimer = setTimeout(checkIn, 30*1000))
}


export function addShutdownHandler(handler: () => Promise<void>) {
  shutdownHandlers.push(handler);
}
