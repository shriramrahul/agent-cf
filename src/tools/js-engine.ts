export type JsResult = {
  /** Value of the last expression / explicit return. */
  output: unknown;
  /** Captured console.log lines, in order. */
  logs: string[];
  error?: string;
};

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...inner: unknown[]) => Promise<unknown>;

/**
 * Sandboxed in-worker JS. Runs as an async function body with a captured
 * console — no access to fetch, KV, or D1 unless explicitly passed in.
 * Timeout is best-effort (it wins the race, it cannot kill the code).
 */
export async function executeJs(code: string, timeoutMs = 1000): Promise<JsResult> {
  const logs: string[] = [];
  const consoleProxy = {
    log: (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(' '));
    },
  };

  const run = new AsyncFunction('console', `"use strict";\n${code}`)(consoleProxy) as Promise<unknown>;
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs),
  );

  try {
    const output = await Promise.race([run, timeout]);
    return { output: output ?? null, logs };
  } catch (err) {
    return { output: null, logs, error: err instanceof Error ? err.message : String(err) };
  }
}
