import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { AcpProvider } from './acp.js';
import type { ProviderEvent } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, '../test-fixtures/mock-acp-agent.ts');

function collectEvents(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const collected: ProviderEvent[] = [];
  return (async () => {
    for await (const event of events) {
      collected.push(event);
    }
    return collected;
  })();
}

function seedDestinations(channelType: string, platformId: string, name: string): void {
  const db = getInboundDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_routing (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      channel_type TEXT,
      platform_id  TEXT,
      thread_id    TEXT
    )
  `);
  db.prepare(
    'INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)',
  ).run(channelType, platformId, null);
  db.prepare(
    'INSERT OR REPLACE INTO destinations (name, display_name, type, channel_type, platform_id) VALUES (?, ?, ?, ?, ?)',
  ).run(name, name, 'channel', channelType, platformId);
}

describe('AcpProvider', () => {
  beforeEach(() => {
    initTestSessionDb();
  });

  afterEach(() => {
    closeSessionDb();
  });

  it('echoes a prompt and wraps the result for delivery', async () => {
    if (!fs.existsSync(fixturePath)) {
      throw new Error(`Mock ACP agent not found: ${fixturePath}`);
    }

    seedDestinations('discord', 'chan-1', 'discord-test');

    const provider = new AcpProvider({
      env: { ...process.env } as Record<string, string>,
      acp: {
        command: 'bun',
        args: ['run', fixturePath],
      },
    });

    const query = provider.query({
      prompt: 'hello from nanoclaw',
      cwd: '/workspace/agent',
    });

    const eventsPromise = collectEvents(query.events);

    // 给 mock agent 一点启动时间
    await new Promise((r) => setTimeout(r, 500));
    query.end();

    const events = await eventsPromise;
    const results = events.filter((e) => e.type === 'result');

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].text).toContain('<message to="discord-test">');
    expect(results[0].text).toContain('hello from nanoclaw');
  });

  it('detects invalid session errors', () => {
    const provider = new AcpProvider({});
    expect(provider.isSessionInvalid(new Error('session test-session not found'))).toBe(true);
    expect(provider.isSessionInvalid(new Error('network timeout'))).toBe(false);
  });
});
