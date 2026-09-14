import type { Env, IncomingMessage, OutgoingMessage } from './types/client';
import { SessionManager, type ChatMessage } from './session/session-manager';
import { logEvent, markEvent } from './db/tasks';
import { runTool, toolDefs } from './tools';

const MODEL = 'gemma-4-26b-a4b-it';
const MAX_STEPS = 5;

const SYSTEM_PROMPT = [
  'You are a personal execution agent. Keep replies short and actionable.',
  'Manage the user\u2019s tasks with the available tools: multi-task messages decompose into discrete operations.',
  'Undated ideas stay in the inbox (omit scheduled_date); only date what is actually scheduled.',
].join(' ');

type NativePart = Record<string, unknown>;
type NativeContent = { role: 'user' | 'model'; parts: NativePart[] };
type NativeCall = { id?: string; name: string; args: Record<string, unknown> };

/** Our stored history -> native contents. Thought parts are dropped. */
function toContents(history: ChatMessage[]): NativeContent[] {
  const out: NativeContent[] = [];
  for (const m of history) {
    if (m.role === 'user') {
      out.push({ role: 'user', parts: [{ text: m.content ?? '' }] });
    } else if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      out.push({
        role: 'model',
        parts: (m.tool_calls as NativeCall[]).map((c) => ({
          functionCall: { name: c.name, args: c.args ?? {}, ...(c.id ? { id: c.id } : {}) },
        })),
      });
    } else if (m.role === 'assistant') {
      out.push({ role: 'model', parts: [{ text: m.content ?? '' }] });
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.name ?? 'result',
              response: { result: tryParse(m.content) },
              ...(m.tool_call_id ? { id: m.tool_call_id } : {}),
            },
          },
        ],
      });
    }
  }
  return out;
}

function tryParse(content: string | null): unknown {
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

async function generate(
  env: Env,
  system: string,
  contents: NativeContent[],
  withTools: boolean,
): Promise<{ text: string; calls: NativeCall[] }> {
  const key = env.GEMINI_API_KEY as string | undefined;
  if (!key) throw new Error('LLM binding missing: GEMINI_API_KEY');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents,
      ...(withTools
        ? { tools: [{ functionDeclarations: toolDefs.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }] }
        : {}),
    }),
  });
  if (!res.ok) throw new Error(`LLM request failed: ${res.status}`);
  const data = (await res.json()) as { candidates: { content: { parts: NativePart[] } }[] };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text as string)
    .join('')
    .trim();
  const calls = parts
    .filter((p) => p.functionCall)
    .map((p) => {
      const fc = p.functionCall as { id?: string; name: string; args: Record<string, unknown> };
      return { id: fc.id, name: fc.name, args: fc.args ?? {} };
    });
  return { text, calls };
}

/** Compaction summarizer: folds overflow messages into the rolling summary. */
async function summarize(env: Env, removed: ChatMessage[]): Promise<string> {
  const { text } = await generate(
    env,
    'Summarize these chat messages in 5-10 lines, preserving tasks, decisions, and open loops.',
    [{ role: 'user', parts: [{ text: JSON.stringify(removed) }] }],
    false,
  );
  return text;
}

export async function runAgentLoop(incoming: IncomingMessage, env: Env): Promise<OutgoingMessage> {
  const fail = (code: string, message: string, text: string): OutgoingMessage => ({
    sessionId: incoming.sessionId,
    text,
    clientType: incoming.clientType,
    error: { code, message, retryable: true },
  });

  // Zero data loss: raw ingress is logged before anything else runs.
  let eventId: string | null = null;
  try {
    if (!env.SESSIONS) return fail('NO_SESSION_STORE', 'KV binding missing: SESSIONS', 'Session storage is not configured yet.');
    eventId = await logEvent(env, incoming.text, incoming.clientType);
    const sessions = new SessionManager(
      env.SESSIONS as KVNamespace,
      (removed) => summarize(env, removed),
    );
    const history = await sessions.getHistory(incoming.sessionId);
    const summary = await sessions.getSummary(incoming.sessionId);

    const system = [`${SYSTEM_PROMPT} Today is ${new Date().toISOString().slice(0, 10)}.`];
    if (summary) system.push(`Conversation so far: ${summary}`);

    const userMsg: ChatMessage = { role: 'user', content: incoming.text };
    const contents = [...toContents(history), { role: 'user', parts: [{ text: incoming.text }] } as NativeContent];
    const fresh: ChatMessage[] = [userMsg];

    let reply = '';
    for (let step = 0; step < MAX_STEPS; step++) {
      const { text, calls } = await generate(env, system.join('\n\n'), contents, true);
      if (calls.length === 0) {
        reply = text;
        fresh.push({ role: 'assistant', content: reply });
        contents.push({ role: 'model', parts: [{ text: reply }] });
        break;
      }
      contents.push({
        role: 'model',
        parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args, ...(c.id ? { id: c.id } : {}) } })),
      });
      fresh.push({ role: 'assistant', content: text || null, tool_calls: calls });
      for (const call of calls) {
        let result: unknown;
        try {
          result = await runTool(call.name, call.args, env);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name: call.name, response: { result }, ...(call.id ? { id: call.id } : {}) } }],
        });
        fresh.push({ role: 'tool', name: call.name, content: JSON.stringify(result), tool_call_id: call.id });
      }
    }
    if (!reply) {
      const final = await generate(env, system.join('\n\n'), contents, false);
      reply = final.text || 'Done.';
      fresh.push({ role: 'assistant', content: reply });
    }

    await sessions.appendMessages(incoming.sessionId, fresh);
    if (eventId) await markEvent(env, eventId, 'processed');
    return { sessionId: incoming.sessionId, text: reply, clientType: incoming.clientType, format: 'plain' };
  } catch (err) {
    if (eventId) await markEvent(env, eventId, 'failed').catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    return fail('AGENT_FAILED', message, 'Sorry, I hit a snag — please try again.');
  }
}
