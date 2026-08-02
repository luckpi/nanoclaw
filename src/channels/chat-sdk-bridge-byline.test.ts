/**
 * Approval-card actor byline in the Chat SDK bridge.
 *
 * Drives the bridge's real onAction handler through the real Chat SDK
 * dispatch (`chat.processAction`): `bridge.setup()` registers the handler on
 * a real Chat instance, which the test captures from the webhook-server
 * registration (mocked so no HTTP server binds a port). After a button click
 * the bridge edits the card; the edit must append " — <actor>" so shared
 * channels see who resolved an approval. The replacement card must not retain
 * the original action buttons.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, Chat } from 'chat';

const captured = vi.hoisted(() => ({ chat: null as unknown }));

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn((chat: unknown) => {
    captured.chat = chat;
  }),
}));

vi.mock('../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { log } from '../log.js';
import type { ChannelSetup } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerQuestionRenderResolver } from './question-render-registry.js';

interface CapturedEdit {
  threadId: string;
  messageId: string;
  message: { card?: unknown; fallbackText?: string };
}

function makeAdapter(edits: CapturedEdit[], editFailure?: Error): Adapter {
  return {
    name: 'stub',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => `stub:${threadId}`,
    editMessage: async (threadId: string, messageId: string, content: { card?: unknown; fallbackText?: string }) => {
      if (editFailure) throw editFailure;
      edits.push({ threadId, messageId, message: content });
    },
  } as unknown as Adapter;
}

async function fireAction(
  user: Record<string, unknown>,
  actionId = 'ncq:q-1:approve',
  value = 'approve',
  editFailure?: Error,
  updateCard?: boolean,
): Promise<{ edits: CapturedEdit[]; actions: string[] }> {
  const edits: CapturedEdit[] = [];
  const actions: string[] = [];
  const adapter = makeAdapter(edits, editFailure);
  const bridge = createChatSdkBridge({ adapter, supportsThreads: false });

  await bridge.setup({
    onInbound: async () => {},
    onInboundEvent: async () => {},
    onMetadata: () => {},
    onAction: (questionId: string, selectedOption: string, userId: string) => {
      actions.push(`${questionId}:${selectedOption}:${userId}`);
      return updateCard;
    },
  } as ChannelSetup);

  const chat = captured.chat as Chat;
  expect(chat).toBeTruthy();
  await chat.processAction(
    {
      actionId,
      adapter,
      messageId: 'msg-1',
      raw: {},
      threadId: 'T-1',
      user: user as never,
      value,
    },
    undefined,
  );
  return { edits, actions };
}

beforeEach(() => {
  captured.chat = null;
  vi.clearAllMocks();
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('chat-sdk-bridge approval-card byline', () => {
  it('appends the acting user and removes actions from the resolved card', async () => {
    const { edits, actions } = await fireAction({ userId: 'U1', userName: 'gavriel', fullName: 'Gavriel C' });

    expect(edits).toHaveLength(1);
    expect(edits[0].threadId).toBe('T-1');
    expect(edits[0].messageId).toBe('msg-1');
    expect(edits[0].message.fallbackText).toContain('approve — gavriel');
    const card = JSON.stringify(edits[0].message.card);
    expect(card).toContain('approve — gavriel');
    expect(card).not.toContain('"type":"actions"');
    expect(card).not.toContain('ncq:');
    expect(actions).toEqual(['q-1:approve:U1']);
  });

  it('falls back to fullName when userName is missing', async () => {
    const { edits } = await fireAction({ userId: 'U2', fullName: 'Gavriel C' });

    expect(edits).toHaveLength(1);
    expect(edits[0].message.fallbackText).toContain('— Gavriel C');
  });

  it('omits the byline when the actor has no name', async () => {
    const { edits } = await fireAction({ userId: 'U3' });

    expect(edits).toHaveLength(1);
    expect(edits[0].message.fallbackText).not.toContain('—');
    expect(edits[0].message.fallbackText).toContain('approve');
  });

  it('resolves compact option indexes through a module resolver', async () => {
    registerQuestionRenderResolver((questionId) => {
      if (questionId !== 'module-compact-question') return undefined;
      return {
        title: 'Gateway approval',
        options: [{ label: 'Approve', selectedLabel: 'Approved safely', value: 'approve-real-value' }],
      };
    });

    const { edits, actions } = await fireAction(
      { userId: 'U4', userName: 'reviewer' },
      'ncq:module-compact-question:0',
      '0',
    );

    expect(edits[0].message.fallbackText).toContain('Gateway approval');
    expect(edits[0].message.fallbackText).toContain('Approved safely — reviewer');
    expect(actions).toEqual(['module-compact-question:approve-real-value:U4']);
  });

  it('does not edit a card when the response owner suppresses the generic update', async () => {
    const { edits, actions } = await fireAction(
      { userId: 'U5', userName: 'bystander' },
      'ncq:q-protected:approve',
      'approve',
      undefined,
      false,
    );

    expect(actions).toEqual(['q-protected:approve:U5']);
    expect(edits).toHaveLength(0);
  });

  it('logs only a stable code when an interactive card edit fails', async () => {
    await fireAction(
      { userId: 'user-private-sentinel', userName: 'name-private-sentinel' },
      'ncq:question-private-sentinel:option-private-sentinel',
      'value-private-sentinel',
      new Error('adapter-error-private-sentinel'),
    );

    expect(log.warn).toHaveBeenCalledWith('Question card edit failed', { code: 'QUESTION_CARD_EDIT_FAILED' });
    const serializedLogs = JSON.stringify(vi.mocked(log.warn).mock.calls);
    for (const sentinel of [
      'user-private-sentinel',
      'name-private-sentinel',
      'question-private-sentinel',
      'option-private-sentinel',
      'value-private-sentinel',
      'adapter-error-private-sentinel',
    ]) {
      expect(serializedLogs).not.toContain(sentinel);
    }
  });
});
