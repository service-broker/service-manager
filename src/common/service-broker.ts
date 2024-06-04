import { ServiceBroker } from "@service-broker/service-broker-client";
import config from "../config";
import logger from "./logger";


const defaultServiceBroker = new ServiceBroker({url: config.serviceBrokerUrl, logger});
export default defaultServiceBroker;
