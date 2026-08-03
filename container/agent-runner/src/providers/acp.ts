import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type * as schema from '@agentclientprotocol/sdk';

import { getInboundDb } from '../db/connection.js';
import { findByRouting, getAllDestinations, type DestinationEntry } from '../destinations.js';
import { getConfig } from '../config.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, AcpConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[acp-provider] ${msg}`);
}

/** 内置 ACP agent 启动命令映射。key 对应 `model` 字段。 */
const BUILT_IN_COMMANDS: Record<string, { command: string; args: string[] }> = {
  codex: { command: 'codex-acp', args: [] },
  'codex-acp': { command: 'codex-acp', args: [] },
  claude: { command: 'claude-agent-acp', args: [] },
  'claude-agent': { command: 'claude-agent-acp', args: [] },
  opencode: { command: 'opencode-ai', args: ['acp'] },
  pi: { command: 'pi-acp', args: [] },
};

/** 从 model + acp 配置解析最终启动命令。 */
function resolveCommand(model: string | undefined, acpConfig: AcpConfig | undefined): string {
  if (acpConfig?.command) return acpConfig.command;
  const builtIn = model && BUILT_IN_COMMANDS[model];
  if (builtIn) return builtIn.command;
  throw new Error(
    `ACP provider 缺少命令配置。请设置 ncl groups config update --model <agent>，或在 groups/<folder>/acp.json 里设置 command。`,
  );
}

function resolveArgs(model: string | undefined, acpConfig: AcpConfig | undefined): string[] {
  if (acpConfig?.command) return acpConfig.args ?? [];
  const builtIn = model && BUILT_IN_COMMANDS[model];
  if (builtIn) return builtIn.args;
  return [];
}

/** 事件队列：把异步产生的 ProviderEvent 交给 events 生成器消费。 */
class ProviderEventQueue {
  private queue: ProviderEvent[] = [];
  private waiting: ((value: ProviderEvent | null) => void) | null = null;
  private finished = false;

  push(event: ProviderEvent): void {
    if (this.finished) return;
    this.queue.push(event);
    if (this.waiting) {
      this.waiting(event);
      this.waiting = null;
    }
  }

  async next(): Promise<ProviderEvent | null> {
    if (this.queue.length > 0) return this.queue.shift()!;
    if (this.finished) return null;
    return new Promise<ProviderEvent | null>((resolve) => {
      this.waiting = resolve;
    });
  }

  finish(): void {
    this.finished = true;
    if (this.waiting) {
      this.waiting(null);
      this.waiting = null;
    }
  }
}

/** 判断路径是否允许访问（只允许 workspace 下）。 */
function isPathAllowed(filePath: string, roots: string[]): boolean {
  const real = path.resolve(filePath);
  for (const root of roots) {
    const realRoot = path.resolve(root);
    if (real === realRoot || real.startsWith(realRoot + path.sep)) return true;
  }
  return false;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class AcpProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private options: ProviderOptions;
  private acpConfig: AcpConfig;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
    // 优先使用 ProviderOptions 里的 acp 配置，其次回退到全局 config.acp。
    if (options.acp) {
      this.acpConfig = options.acp;
    } else {
      try {
        this.acpConfig = getConfig().acp ?? {};
      } catch {
        this.acpConfig = {};
      }
    }
  }

  registerMemorySessionHook(): void {
    // ACP agent 没有原生的 session-start hook。
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /session.*not found|unknown session|session.*invalid|no conversation found/i.test(msg);
  }

  maybeRotateContinuation(): string | null {
    // ACP 当前版本不重连旧 session；每次容器唤醒都新建 session。
    return null;
  }

  query(input: QueryInput): AgentQuery {
    const queue = new ProviderEventQueue();
    const pending: string[] = [input.prompt];

    const cwd = this.acpConfig.cwd ?? input.cwd;
    const command = resolveCommand(this.options.model, this.acpConfig);
    const args = resolveArgs(this.options.model, this.acpConfig);
    const additionalDirectories = [
      ...new Set([cwd, ...(this.acpConfig.additionalDirectories ?? []), ...(this.options.additionalDirectories ?? [])]),
    ];
    const allowedFileRoots = additionalDirectories.concat('/workspace');
    const childEnv = { ...this.options.env, ...this.acpConfig.env } as Record<string, string>;

    const instructions = input.systemContext?.instructions;

    let ended = false;
    let aborted = false;
    let promptInFlight = false;
    let firstPrompt = true;
    let currentText = '';
    let child: ChildProcess | undefined;
    let activeSession: acp.ActiveSession | undefined;
    let clientCtx: acp.ClientContext | undefined;
    let sessionId: string | undefined;

    let pushResolver: (() => void) | null = null;
    let doneResolver: (() => void) | null = null;

    const resolvePush = (): void => {
      if (pushResolver) {
        pushResolver();
        pushResolver = null;
      }
    };
    const resolveDone = (): void => {
      if (doneResolver) {
        doneResolver();
        doneResolver = null;
      }
    };

    const buildPromptBlocks = (text: string): schema.ContentBlock[] => {
      const blocks: schema.ContentBlock[] = [];
      if (firstPrompt && instructions?.trim()) {
        blocks.push({ type: 'text', text: instructions });
      }
      blocks.push({ type: 'text', text });
      return blocks;
    };

    const handlePermission = (params: schema.RequestPermissionRequest): schema.RequestPermissionResponse => {
      const mode = this.acpConfig.permissionMode ?? 'auto-approve';
      const wanted = mode === 'auto-deny' ? 'reject' : 'allow';

      for (const option of params.options) {
        if (option.kind?.startsWith(wanted)) {
          return {
            outcome: { outcome: 'selected', optionId: option.optionId },
          };
        }
      }

      // 没有符合预期的 option 时回退到取消。
      return { outcome: { outcome: 'cancelled' } };
    };

    const handleReadTextFile = (params: schema.ReadTextFileRequest): schema.ReadTextFileResponse => {
      if (!isPathAllowed(params.path, allowedFileRoots)) {
        throw new Error(`Path not allowed: ${params.path}`);
      }
      try {
        const content = fs.readFileSync(params.path, 'utf8');
        return { content };
      } catch (err) {
        throw new Error(`Failed to read ${params.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const handleWriteTextFile = (params: schema.WriteTextFileRequest): schema.WriteTextFileResponse => {
      if (!isPathAllowed(params.path, allowedFileRoots)) {
        throw new Error(`Path not allowed: ${params.path}`);
      }
      const dir = path.dirname(params.path);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(params.path, params.content, 'utf8');
      return {};
    };

    const wrapForDelivery = (text: string): string | null => {
      if (!text) return null;

      const db = getInboundDb();
      const routing = db.prepare('SELECT channel_type, platform_id FROM session_routing WHERE id = 1').get() as
        { channel_type?: string; platform_id?: string } | undefined;

      let dest: DestinationEntry | undefined;
      if (routing?.channel_type && routing?.platform_id) {
        dest = findByRouting(routing.channel_type, routing.platform_id);
      }
      if (!dest) {
        const all = getAllDestinations();
        dest = all[0];
      }
      if (!dest) {
        log('no destination available; cannot deliver ACP response');
        return null;
      }
      return `<message to="${dest.name}">${escapeXml(text)}</message>`;
    };

    const translateUpdate = (update: schema.SessionUpdate): ProviderEvent[] => {
      const events: ProviderEvent[] = [];

      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        currentText += update.content.text;
      }

      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        const title = (update as schema.ToolCall).title ?? (update as schema.ToolCallUpdate).title ?? 'tool call';
        events.push({ type: 'progress', message: `[ACP] ${title}` });
      } else if (update.sessionUpdate === 'plan') {
        const entries = (update as schema.Plan).entries ?? [];
        const summary = entries.map((e) => e.content ?? '—').join(' › ');
        if (summary) events.push({ type: 'progress', message: `[ACP] plan: ${summary}` });
      } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text') {
        events.push({ type: 'activity' });
      } else {
        // 任何其他 update 都算作活跃度信号，避免被 host 判定为卡住。
        events.push({ type: 'activity' });
      }

      return events;
    };

    const runLoop = async (): Promise<void> => {
      try {
        child = spawn(command, args, {
          cwd,
          env: childEnv,
          stdio: ['pipe', 'pipe', 'inherit'],
        });

        const stream = acp.ndJsonStream(
          Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
        );

        const app = acp
          .client({ name: 'nanoclaw-acp' })
          .onRequest(acp.methods.client.session.requestPermission, (ctx) => handlePermission(ctx.params))
          .onRequest(acp.methods.client.fs.readTextFile, (ctx) => handleReadTextFile(ctx.params))
          .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => handleWriteTextFile(ctx.params));

        await app.connectWith(stream, async (ctx) => {
          clientCtx = ctx;

          const initRes = await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientInfo: { name: 'nanoclaw', version: '2.0.0' },
            clientCapabilities: {
              fs: { readTextFile: true, writeTextFile: true },
              terminal: false,
            },
          });
          log(`connected (protocol v${initRes.protocolVersion})`);

          const builder = ctx.buildSession(cwd);
          if (additionalDirectories.length > 0) {
            builder.withAdditionalDirectories(additionalDirectories);
          }

          activeSession = await builder.start();
          sessionId = activeSession.sessionId;
          log(`session ${sessionId}`);

          while (!ended && !aborted) {
            if (!promptInFlight) {
              if (pending.length === 0) {
                if (ended) break;
                // 等待 push() 送来新消息
                await new Promise<void>((resolve) => {
                  pushResolver = resolve;
                });
                continue;
              }

              const text = pending.shift()!;
              const blocks = buildPromptBlocks(text);
              currentText = '';
              promptInFlight = true;
              firstPrompt = false;

              log(`sending prompt (${blocks.length} block(s))`);
              // 不 await prompt()，让 nextUpdate() 驱动事件流
              activeSession.prompt(blocks);
            }

            const message = await activeSession.nextUpdate();
            if (aborted) break;

            if (message.kind === 'session_update') {
              for (const event of translateUpdate(message.update)) {
                queue.push(event);
              }
            } else {
              // stop: 本轮完成
              promptInFlight = false;
              const resultText = wrapForDelivery(currentText);
              if (!aborted) {
                queue.push({ type: 'result', text: resultText });
              }
              currentText = '';

              if (pending.length === 0 && ended) break;
            }
          }
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`ACP error: ${msg}`);
        if (!aborted) {
          queue.push({ type: 'error', message: msg, retryable: true });
        }
      } finally {
        if (activeSession) activeSession.dispose();
        if (child && !child.killed) child.kill();
        queue.finish();
      }
    };

    // 在后台启动 ACP 连接与事件循环。
    const runPromise = runLoop();

    return {
      push: (message: string): void => {
        if (ended || aborted) return;
        pending.push(message);
        resolvePush();
      },
      end: (): void => {
        if (ended || aborted) return;
        ended = true;
        resolvePush();
        resolveDone();
      },
      abort: (): void => {
        if (aborted) return;
        aborted = true;
        if (clientCtx && sessionId) {
          void clientCtx.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {});
        }
        if (activeSession) activeSession.dispose();
        resolvePush();
        resolveDone();
      },
      events: (async function* () {
        // 确保事件循环抛出的未捕获错误不会搞砸整个生成器
        runPromise.catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          queue.push({ type: 'error', message: msg, retryable: true });
          queue.finish();
        });

        while (true) {
          const event = await queue.next();
          if (event === null) return;
          yield event;
        }
      })(),
    };
  }
}

registerProvider('acp', (options) => new AcpProvider(options));
