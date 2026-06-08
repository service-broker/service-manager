import * as rxjs from "rxjs";
import config from "../config.js";
import logger from "./logger.js";
import sb from "./service-broker.js";

export const shutdown$ = new rxjs.ReplaySubject<void>(1)

shutdown$.pipe(
  rxjs.delay(1000)
).subscribe(() => {
  sb.shutdown()
})

sb.setServiceHandler("service-manager-client", req => {
  if (req.header.method == "shutdown") {
    if (req.header.pid != process.pid) throw new Error("pid incorrect");
    logger.info("Remote shutdown requested")
    shutdown$.next()
  } else {
    throw new Error("Unknown method " + req.header.method)
  }
})

if (config.siteName && config.serviceName) {
  rxjs.timer(0, 30*1000).pipe(
    rxjs.takeUntil(shutdown$)
  ).subscribe(() => {
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
  })
}
