/**
 * Response handler registry.
 *
 * Extracted from index.ts so that modules calling `registerResponseHandler()`
 * at import time don't hit a TDZ error on the const-array declaration.
 * index.ts imports src/modules/index.js for its side effects, which triggers
 * module registrations that would otherwise happen before index.ts's own
 * const initializers have run. Host start/shutdown hooks live in
 * host-lifecycle.ts.
 *
 * Keep this file dependency-free (log.js is fine, but nothing from
 * modules/* or index.ts itself). Any file imported here must not in turn
 * import from src/index.ts, or the cycle returns.
 */
import { log } from './log.js';

export interface ResponsePayload {
  questionId: string;
  value: string;
  userId: string | null;
  channelType: string;
  platformId: string;
  threadId: string | null;
}

export type ResponseHandler = (payload: ResponsePayload) => Promise<boolean>;

const responseHandlers: ResponseHandler[] = [];

export function registerResponseHandler(handler: ResponseHandler): void {
  responseHandlers.push(handler);
}

export function getResponseHandlers(): readonly ResponseHandler[] {
  return [...responseHandlers];
}

/**
 * Dispatch a response through registered handlers in registration order.
 *
 * Handler failures are isolated so another handler can still claim the
 * response. The project-standard error object is logged, but the response
 * payload itself is never included in the log entry.
 *
 * Returns true when the first handler claims the response and false when no
 * handler claims it.
 */
export async function dispatchResponse(payload: ResponsePayload): Promise<boolean> {
  for (const handler of [...responseHandlers]) {
    /* eslint-disable no-catch-all/no-catch-all -- one optional handler must not block later response owners */
    try {
      if (await handler(payload)) return true;
    } catch (err) {
      log.error('Response handler failed', { err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
  log.warn('Response was not claimed', { code: 'RESPONSE_UNCLAIMED' });
  return false;
}
