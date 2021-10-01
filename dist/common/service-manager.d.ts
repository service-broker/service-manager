export declare function shutdown(): Promise<void>;
export declare function addShutdownHandler(handler: () => Promise<void>): void;
