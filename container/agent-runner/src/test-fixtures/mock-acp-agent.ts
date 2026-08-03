import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const sessions = new Map<string, AbortController | null>();

/**
 * 用于测试 ACP provider 的最小 mock agent。
 * 通过 stdio 接收 JSON-RPC，把用户 prompt 中的 text 块 echo 回去。
 */
acp
  .agent({ name: 'mock-acp-agent' })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: false,
      multiTurn: true,
    },
  }))
  .onRequest(acp.methods.agent.session.new, () => {
    const sessionId = `mock-session-${Date.now()}`;
    sessions.set(sessionId, null);
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const { sessionId, prompt } = ctx.params as { sessionId: string; prompt: acp.ContentBlock[] };
    const controller = new AbortController();
    sessions.set(sessionId, controller);

    const text = prompt
      .filter((b): b is acp.ContentBlock & { type: 'text' } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    if (controller.signal.aborted) {
      return { stopReason: 'cancelled' as acp.StopReason };
    }

    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Echo: ' },
      },
    });

    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: text },
      },
    });

    return { stopReason: 'end_turn' as acp.StopReason };
  })
  .onNotification(acp.methods.agent.session.cancel, (ctx) => {
    const session = sessions.get(ctx.params.sessionId);
    if (session) session.abort();
  })
  .connect(
    acp.ndJsonStream(
      Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
    ),
  );
