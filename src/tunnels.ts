import { ChildProcess, spawn } from "child_process";
import logger from "./common/logger"

const tunnels = new Map<string, ChildProcess>()

export function createTunnel(hostName: string, fromPort: number, toHost: string, toPort: number) {
  const key = `${hostName}:${fromPort}`
  if (tunnels.has(key)) {
    logger.warn("Can't create, tunnel exists")
  } else {
    const tunnelArgs = fromPort < 0
      ? ["-R", `${-fromPort}:${toHost}:${toPort}`]
      : ["-L", `${fromPort}:${toHost}:${toPort}`]
    const child = spawn("ssh", ["-N", "-o", "BatchMode=yes", ...tunnelArgs, hostName])
    child.once("spawn", () => logger.info("Tunnel", child.pid, "STARTED"))
    child.on("error", err => logger.error("Tunnel", child.pid, err))
    child.once("close", () => logger.info("Tunnel", child.pid, "TERMINATED"))
    tunnels.set(key, child)
  }
}

export function destroyTunnel(hostName: string, fromPort: number) {
  const key = `${hostName}:${fromPort}`
  const child = tunnels.get(key)
  if (child) {
    logger.info("Tunnel", child.pid, "kill")
    child.kill()
    tunnels.delete(key)
  } else {
    logger.warn("Can't destroy, tunnel not exists")
  }
}
