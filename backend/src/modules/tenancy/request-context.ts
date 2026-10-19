import { AsyncLocalStorage } from 'async_hooks';

/** Per-request policy resolved by the workspace guard and read deep in the data layer (e.g. statement timeout). */
export interface RequestPolicy { timeoutMs?: number | undefined; allowStreaming?: boolean | undefined }
export const requestPolicy = new AsyncLocalStorage<RequestPolicy>();
