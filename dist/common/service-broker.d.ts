/// <reference types="node" />
import { Readable } from "stream";
export interface Message {
    header?: {
        [key: string]: any;
    };
    payload?: string | Buffer | Readable;
}
export declare function advertise(service: {
    name: string;
    capabilities?: string[];
    priority?: number;
}, handler: (msg: Message) => Message | Promise<Message>): Promise<void>;
export declare function unadvertise(serviceName: string): Promise<void>;
export declare function setServiceHandler(serviceName: string, handler: (msg: Message) => Message | Promise<Message>): void;
export declare function request(service: {
    name: string;
    capabilities?: string[];
}, req: Message, timeout?: number): Promise<Message>;
export declare function notify(service: {
    name: string;
    capabilities?: string[];
}, msg: Message): Promise<void>;
export declare function requestTo(endpointId: string, serviceName: string, req: Message, timeout?: number): Promise<Message>;
export declare function notifyTo(endpointId: string, serviceName: string, msg: Message): Promise<void>;
export declare function publish(topic: string, text: string): Promise<void>;
export declare function subscribe(topic: string, handler: (text: string) => void): Promise<void>;
export declare function status(): Promise<any>;
export declare function shutdown(): Promise<void>;
