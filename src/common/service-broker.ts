import { ServiceBroker } from "@service-broker/client-node";
import config from "../config.js";
import logger from "./logger.js";

const sb = new ServiceBroker({
  url: config.serviceBrokerUrl,
  repeatConfig: { delay: 1_000 },
  retryConfig: { delay: 15_000 }
})

sb.on('connect', () => logger.info('Service broker connection established'))
  .on('close', (code, reason) => logger.info('Service broker connection closed', code, reason))
  .on('error', err => logger.error('Service broker connection error', err))

export default sb
