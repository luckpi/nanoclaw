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

/**
 * A handler normally returns true to claim the response and let the channel
 * render the selected option. Security-sensitive handlers can claim a click
 * without changing the card (for example, a wrong-user or replayed click).
 */
export interface ClaimedResponse {
  claimed: true;
  updateCard: boolean;
}

export type ResponseHandlerResult = boolean | ClaimedResponse;
export type ResponseHandler = (payload: ResponsePayload) => Promise<ResponseHandlerResult>;

export const RESPONSE_CLAIMED_NO_CARD_UPDATE: ClaimedResponse = Object.freeze({
  claimed: true,
  updateCard: false,
});

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
 * Returns true only when the channel should render its generic selected-option
 * card. False means either no handler claimed the response or a handler claimed
 * it while deliberately suppressing that generic card update.
 */
export async function dispatchResponse(payload: ResponsePayload): Promise<boolean> {
  for (const handler of [...responseHandlers]) {
    /* eslint-disable no-catch-all/no-catch-all -- one optional handler must not block later response owners */
    try {
      const result = await handler(payload);
      if (typeof result === 'object' && result.claimed) return result.updateCard;
      if (result) return true;
    } catch (err) {
      log.error('Response handler failed', { err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
  log.warn('Response was not claimed', { code: 'RESPONSE_UNCLAIMED' });
  return false;
}
