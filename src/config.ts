import * as dotenv from "dotenv"
import * as assert from "assert"

dotenv.config();

assert(process.env.SERVICE_BROKER_URL, "Missing env SERVICE_BROKER_URL")
assert(process.env.PASSWORD, "Missing env PASSWORD")

export interface Commands {
  listServices: string;
  readServiceConf: string;
  deployService: string;
  undeployService: string;
  startService: string;
  killService: string;
  checkService: string;
  updateService: string;
  viewServiceLogs: string;
}

export default {
  password: process.env.PASSWORD,
  saveStateInterval: 30*1000,
  clientsKeepAliveInterval: 30*1000,

  commands: <{[operatingSystem: string]: Commands}> {
    unix: {
      listServices: "ls ${deployFolder}",
      readServiceConf: "cat ${deployFolder}/${serviceName}/.env",
      deployService: "cd ${deployFolder} && git clone --single-branch --branch ${repoTag} ${repoUrl} ${serviceName} && cd ${serviceName} && npm i --omit=dev --no-save",
      undeployService: "rm -rf ${deployFolder}/${serviceName}",
      startService: "cd ${deployFolder}/${serviceName} && " + (process.env.START_COMMAND ?? "npm start") + " 1>stdout.log 2>stderr.log",
      killService: "kill -9 ${pid}",
      checkService: "timeout ${timeout} tail -f --pid=${pid} /dev/null; kill -0 ${pid}",
      updateService: "cd ${deployFolder}/${serviceName} && git fetch origin ${repoTag} && git reset --hard origin/${repoTag} && npm i --omit=dev --no-save",
      viewServiceLogs: "cd ${deployFolder}/${serviceName} && touch stdout.log stderr.log && tail -n ${lines} stdout.log && tail -n ${lines} stderr.log 1>&2",
    },
    windows: {
      listServices: "dir /B ${deployFolder}",
      readServiceConf: "type ${deployFolder}\\${serviceName}\\.env",
      deployService: "cd ${deployFolder} && git clone --single-branch --branch ${repoTag} ${repoUrl} ${serviceName} && cd ${serviceName} && npm i --omit=dev --no-save",
      undeployService: "rmdir /S /Q ${deployFolder}\\${serviceName}",
      startService: "cd ${deployFolder}\\${serviceName} && " + (process.env.START_COMMAND ?? "npm start") + " 1>stdout.log 2>stderr.log",
      killService: "taskkill /F /PID ${pid}",
      checkService: "powershell Wait-Process -Id ${pid} -Timeout ${timeout}; Get-Process -Id ${pid}",
      updateService: "cd ${deployFolder}\\${serviceName} && git fetch origin ${repoTag} && git reset --hard origin/${repoTag} && npm i --omit=dev --no-save",
      viewServiceLogs: "cd ${deployFolder}\\${serviceName} && (if not exist stdout.log copy NUL stdout.log) && (if not exist stderr.log copy NUL stderr.log) && powershell Get-Content -Tail ${lines} stdout.log && powershell Get-Content -Tail ${lines} stderr.log 1>&2",
    }
  },

  // service broker info
  serviceBrokerUrl: process.env.SERVICE_BROKER_URL,

  // service deployment info
  siteName: process.env.SITE_NAME,
  serviceName: process.env.SERVICE_NAME,

  // the service provided by this module
  service: {
    name: "service-manager",
    priority: 100
  }
}
