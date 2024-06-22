"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const service_broker_client_1 = require("@service-broker/service-broker-client");
const config_1 = __importDefault(require("../config"));
const logger_1 = __importDefault(require("./logger"));
const defaultServiceBroker = new service_broker_client_1.ServiceBroker({ url: config_1.default.serviceBrokerUrl, logger: logger_1.default });
exports.default = defaultServiceBroker;
