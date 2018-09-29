/// <reference types="node" />
import { Readable } from "stream";
export interface Message {
    header?: {
        [key: string]: any;
    };
    payload?: string | Buffer | Readable;
}
export declare class ServiceBroker {
    private url;
    private readonly providers;
    private readonly pending;
    private pendingIdGen;
    private readonly getConnection;
    private shutdownFlag;
    constructor(url: string);
    private connect;
    private onMessage;
    private onServiceRequest;
    private onServiceResponse;
    private messageFromString;
    private messageFromBuffer;
    private send;
    private packetizer;
    advertise(service: {
        name: string;
        capabilities?: string[];
        priority?: number;
    }, handler: (msg: Message) => Message | Promise<Message>): Promise<void>;
    unadvertise(serviceName: string): Promise<void>;
    setServiceHandler(serviceName: string, handler: (msg: Message) => Message | Promise<Message>): void;
    request(service: {
        name: string;
        capabilities?: string[];
    }, req: Message, timeout?: number): Promise<Message>;
    notify(service: {
        name: string;
        capabilities?: string[];
    }, msg: Message): Promise<void>;
    requestTo(endpointId: string, serviceName: string, req: Message, timeout?: number): Promise<Message>;
    notifyTo(endpointId: string, serviceName: string, msg: Message): Promise<void>;
    private pendingResponse;
    publish(topic: string, text: string): Promise<void>;
    subscribe(topic: string, handler: (text: string) => void): Promise<void>;
    unsubscribe(topic: string): Promise<void>;
    status(): Promise<any>;
    shutdown(): Promise<void>;
}
declare const defaultServiceBroker: ServiceBroker;
export default defaultServiceBroker;
