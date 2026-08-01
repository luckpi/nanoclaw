/** Maximum structured CLI input accepted from stdin (64 KiB, measured as UTF-8 bytes). */
export const MAX_STDIN_JSON_BYTES = 64 * 1024;

export type StdinJsonStream = AsyncIterable<string | Uint8Array>;

/**
 * Read one bounded JSON object from stdin and merge it with argv-derived args.
 * A key may come from exactly one source so shell-visible flags cannot be
 * silently replaced by piped data.
 */
export async function readStdinJsonArgs(
  stream: StdinJsonStream,
  argvArgs: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let byteLength = 0;

  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_STDIN_JSON_BYTES) {
      throw new Error(`--stdin-json input exceeds ${MAX_STDIN_JSON_BYTES} bytes`);
    }
    chunks.push(buffer);
  }

  const source = Buffer.concat(chunks, byteLength).toString('utf8');
  if (source.trim().length === 0) {
    throw new Error('--stdin-json input is empty');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new Error('--stdin-json input is not valid JSON', { cause: err });
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--stdin-json input must be one JSON object');
  }

  const stdinArgs = parsed as Record<string, unknown>;
  for (const key of Object.keys(stdinArgs)) {
    if (Object.prototype.hasOwnProperty.call(argvArgs, key)) {
      throw new Error(`--stdin-json key "${key}" is also supplied on argv`);
    }
  }

  // Object.fromEntries defines keys instead of assigning them, so a literal
  // "__proto__" input remains ordinary data and cannot mutate the result's
  // prototype.
  return Object.fromEntries([...Object.entries(argvArgs), ...Object.entries(stdinArgs)]);
}
