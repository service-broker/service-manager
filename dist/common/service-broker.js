"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const service_broker_client_1 = require("@service-broker/service-broker-client");
const config_1 = require("../config");
const logger_1 = require("./logger");
const defaultServiceBroker = new service_broker_client_1.ServiceBroker({ url: config_1.default.serviceBrokerUrl, logger: logger_1.default });
exports.default = defaultServiceBroker;
