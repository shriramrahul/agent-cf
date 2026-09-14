import type { Env, IncomingMessage, OutgoingMessage } from './types/client';
import { SessionManager, type ChatMessage } from './session/session-manager';
import { runTool, toolDefs } from './tools';

const MODEL = 'gemini-2.5-flash';
const MAX_STEPS = 5;

const SYSTEM_PROMPT = [
  'You are a personal execution agent. Keep replies short and actionable.',
  'Manage the user\u2019s tasks with the available tools: multi-task messages decompose into discrete operations.',
  'Undated ideas stay in the inbox (omit scheduled_date); only date what is actually scheduled.',
].join(' ');

type LlmMessage = { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string };

async function chat(env: Env, messages: LlmMessage[], withTools: boolean): Promise<LlmMessage> {
  const key = env.GEMINI_API_KEY as string | undefined;
  if (!key) throw new Error('LLM binding missing: GEMINI_API_KEY');
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages,
      ...(withTools
        ? { tools: toolDefs.map((t) => ({ type: 'function', function: t })) }
        : {}),
    }),
  });
  if (!res.ok) throw new Error(`LLM request failed: ${res.status}`);
  const data = (await res.json()) as { choices: { message: LlmMessage }[] };
  return data.choices[0].message;
}

/** Compaction summarizer: folds overflow messages into the rolling summary. */
async function summarize(env: Env, removed: ChatMessage[]): Promise<string> {
  const msg = await chat(
    env,
    [
      { role: 'system', content: 'Summarize these chat messages in 5-10 lines, preserving tasks, decisions, and open loops.' },
      { role: 'user', content: JSON.stringify(removed) },
    ],
    false,
  );
  return msg.content ?? '';
}

export async function runAgentLoop(incoming: IncomingMessage, env: Env): Promise<OutgoingMessage> {
  const fail = (code: string, message: string, text: string): OutgoingMessage => ({
    sessionId: incoming.sessionId,
    text,
    clientType: incoming.clientType,
    error: { code, message, retryable: true },
  });

  try {
    if (!env.SESSIONS) return fail('NO_SESSION_STORE', 'KV binding missing: SESSIONS', 'Session storage is not configured yet.');
    const sessions = new SessionManager(
      env.SESSIONS as KVNamespace,
      (removed) => summarize(env, removed),
    );
    const history = await sessions.getHistory(incoming.sessionId);
    const summary = await sessions.getSummary(incoming.sessionId);

    const userMsg: ChatMessage = { role: 'user', content: incoming.text };
    const messages: LlmMessage[] = [
      { role: 'system', content: `${SYSTEM_PROMPT} Today is ${new Date().toISOString().slice(0, 10)}.` },
      ...(summary ? [{ role: 'system', content: `Conversation so far (summary): ${summary}` }] : []),
      ...history,
      userMsg,
    ];
    const fresh: ChatMessage[] = [userMsg];

    let reply = '';
    for (let step = 0; step < MAX_STEPS; step++) {
      const msg = await chat(env, messages, true);
      const calls = (msg.tool_calls ?? []) as { id: string; function: { name: string; arguments: string } }[];
      if (calls.length === 0) {
        reply = msg.content ?? '';
        fresh.push({ role: 'assistant', content: reply });
        messages.push({ role: 'assistant', content: reply });
        break;
      }
      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
      fresh.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
      for (const call of calls) {
        let result: unknown;
        try {
          result = await runTool(call.function.name, JSON.parse(call.function.arguments || '{}'), env);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        const toolMsg: ChatMessage = { role: 'tool', content: JSON.stringify(result), tool_call_id: call.id };
        messages.push(toolMsg);
        fresh.push(toolMsg);
      }
    }
    if (!reply) {
      const final = await chat(env, messages, false);
      reply = final.content ?? 'Done.';
      fresh.push({ role: 'assistant', content: reply });
    }

    await sessions.appendMessages(incoming.sessionId, fresh);
    return { sessionId: incoming.sessionId, text: reply, clientType: incoming.clientType, format: 'plain' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail('AGENT_FAILED', message, 'Sorry, I hit a snag — please try again.');
  }
}
