import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

function sentinelPayload() {
  return {
    questionId: 'question-secret-sentinel',
    value: 'selected-value-sentinel',
    userId: 'user-secret-sentinel',
    channelType: 'channel-secret-sentinel',
    platformId: 'platform-secret-sentinel',
    threadId: 'thread-secret-sentinel',
  };
}

describe('response dispatch registry', () => {
  it('returns handler snapshots that cannot mutate the registry', async () => {
    const registry = await import('./response-registry.js');
    const first = vi.fn(async () => false);
    const second = vi.fn(async () => false);

    registry.registerResponseHandler(first);
    const snapshot = registry.getResponseHandlers();
    registry.registerResponseHandler(second);

    expect(snapshot).toEqual([first]);
    expect(registry.getResponseHandlers()).toEqual([first, second]);
  });

  it('dispatches over a snapshot when a handler registers another handler', async () => {
    const registry = await import('./response-registry.js');
    const registeredDuringDispatch = vi.fn(async () => true);
    registry.registerResponseHandler(async () => {
      registry.registerResponseHandler(registeredDuringDispatch);
      return false;
    });

    await expect(registry.dispatchResponse(sentinelPayload())).resolves.toBe(false);
    expect(registeredDuringDispatch).not.toHaveBeenCalled();
    expect(registry.getResponseHandlers()).toContain(registeredDuringDispatch);
  });

  it('returns true on the first claim and does not call later handlers', async () => {
    const registry = await import('./response-registry.js');
    const later = vi.fn(async () => true);
    registry.registerResponseHandler(async () => false);
    registry.registerResponseHandler(async () => true);
    registry.registerResponseHandler(later);

    await expect(registry.dispatchResponse(sentinelPayload())).resolves.toBe(true);
    expect(later).not.toHaveBeenCalled();
  });

  it('returns false and emits only a stable code when no handler claims the response', async () => {
    const registry = await import('./response-registry.js');
    const { log } = await import('./log.js');
    registry.registerResponseHandler(async () => false);

    await expect(registry.dispatchResponse(sentinelPayload())).resolves.toBe(false);

    expect(log.warn).toHaveBeenCalledWith('Response was not claimed', { code: 'RESPONSE_UNCLAIMED' });
    const serializedLogs = JSON.stringify(vi.mocked(log.warn).mock.calls);
    for (const sentinel of Object.values(sentinelPayload())) {
      expect(serializedLogs).not.toContain(sentinel);
    }
  });

  it('continues after a handler throws, logs the error, and does not log the payload', async () => {
    const registry = await import('./response-registry.js');
    const { log } = await import('./log.js');
    const claimed = vi.fn(async () => true);
    const failure = new Error('handler-error-sentinel');
    registry.registerResponseHandler(async () => {
      throw failure;
    });
    registry.registerResponseHandler(claimed);

    await expect(registry.dispatchResponse(sentinelPayload())).resolves.toBe(true);

    expect(claimed).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith('Response handler failed', { err: failure });
    const serializedLogs = JSON.stringify(vi.mocked(log.error).mock.calls);
    for (const sentinel of Object.values(sentinelPayload())) {
      expect(serializedLogs).not.toContain(sentinel);
    }
  });
});
