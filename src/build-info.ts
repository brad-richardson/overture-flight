export const BUILD_HASH: string = __BUILD_HASH__;
export const BUILD_TIMESTAMP: number = __BUILD_TIMESTAMP__;
export const BUILD_DATE: string = new Date(BUILD_TIMESTAMP).toISOString();

declare const __BUILD_HASH__: string;
declare const __BUILD_TIMESTAMP__: number;
