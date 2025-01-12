import { ChildProcess, spawn } from "child_process";
import * as rxjs from "rxjs";
import logger from "./common/logger";

const tunnels = new Map<string, rxjs.Subscription>()

export function createTunnel(hostName: string, fromPort: number, toHost: string, toPort: number) {
  const key = `${hostName}:${fromPort}`
  if (tunnels.has(key)) {
    logger.warn("Can't create, tunnel exists")
  } else {
    tunnels.set(key, setup(hostName, fromPort, toHost, toPort))
  }
}

export function destroyTunnel(hostName: string, fromPort: number) {
  const key = `${hostName}:${fromPort}`
  const sub = tunnels.get(key)
  if (sub) {
    logger.info("Tunnel stop()", hostName, fromPort)
    sub.unsubscribe()
    tunnels.delete(key)
  } else {
    logger.warn("Can't destroy, tunnel not exists")
  }
}



function setup(hostName: string, fromPort: number, toHost: string, toPort: number) {
  const abortCtrl = new AbortController()

  return rxjs.defer(makeChild).pipe(
    rxjs.exhaustMap(child =>
      rxjs.merge(
        rxjs.timer(10*1000),
        waitTerminate(child).then(() => {throw "recreate"})
      )
    ),
    rxjs.retry({
      delay: (err, retryCount) => rxjs.timer(retryCount <= 1 ? 1000 : 15*1000),
      resetOnSuccess: true
    }),
    rxjs.finalize(() => abortCtrl.abort())
  ).subscribe()

  async function makeChild() {
    try {
      const child = spawn("ssh", [
        "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
        ...(fromPort < 0
          ? ["-R", `${-fromPort}:${toHost}:${toPort}`]
          : ["-L", `${fromPort}:${toHost}:${toPort}`]
        ),
        hostName
      ], {
        signal: abortCtrl.signal
      })
      await new Promise((f,r) => child.once("spawn", f).once("error", r))
      logger.info("Tunnel STARTED", hostName, fromPort, child.pid)
      return child
    } catch (err) {
      logger.error("Tunnel start()", hostName, fromPort, err)
      throw err
    }
  }

  async function waitTerminate(child: ChildProcess) {
    child.on("error", err => {
      if (err.name != "AbortError")
        logger.error("Tunnel ERROR", hostName, fromPort, child.pid, err)
    })
    const exitCode = await new Promise<string|number|null>(fulfill =>
      child.once("close", (code, signal) => fulfill(signal ?? code))
    )
    logger.info("Tunnel TERMINATED", hostName, fromPort, child.pid, exitCode)
  }
}
