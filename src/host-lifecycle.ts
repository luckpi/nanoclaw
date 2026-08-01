/**
 * Host module lifecycle registry.
 *
 * Modules register callbacks at import time. Registration is deliberately
 * inert: startup work begins only after the database and delivery adapter are
 * ready, and shutdown work begins only from the host's graceful-shutdown path.
 */
import type Database from 'better-sqlite3';

import { log } from './log.js';

export interface HostStartContext {
  db: Database.Database;
  signal: AbortSignal;
}

export type HostStartCallback = (ctx: HostStartContext) => void | Promise<void>;
export type HostShutdownCallback = () => void | Promise<void>;

const startCallbacks: HostStartCallback[] = [];
const shutdownCallbacks: HostShutdownCallback[] = [];

export function onHostStart(cb: HostStartCallback): void {
  startCallbacks.push(cb);
}

export function onHostShutdown(cb: HostShutdownCallback): void {
  shutdownCallbacks.push(cb);
}

export function getHostStartCallbacks(): readonly HostStartCallback[] {
  return [...startCallbacks];
}

export function getHostShutdownCallbacks(): readonly HostShutdownCallback[] {
  return [...shutdownCallbacks];
}

/** Start registered modules serially. A failed start aborts host startup. */
export async function startHostModules(ctx: HostStartContext): Promise<void> {
  for (const cb of [...startCallbacks]) {
    /* eslint-disable no-catch-all/no-catch-all -- add lifecycle context, then preserve startup failure semantics */
    try {
      await cb(ctx);
    } catch (err) {
      log.error('Host module startup callback failed', { err });
      throw err;
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
}

/**
 * Stop registered modules serially in reverse registration order. One failed
 * cleanup must not prevent the remaining modules or host cleanup from running.
 */
export async function stopHostModules(): Promise<void> {
  for (const cb of [...shutdownCallbacks].reverse()) {
    /* eslint-disable no-catch-all/no-catch-all -- graceful shutdown must continue through every registered cleanup */
    try {
      await cb();
    } catch (err) {
      log.error('Host module shutdown callback failed', { err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
}
