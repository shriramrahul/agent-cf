import type { Env, IncomingMessage, OutgoingMessage } from './types/client';
import { SessionManager, dropOrphans, type ChatMessage } from './session/session-manager';
import { logEvent, markEvent } from './db/tasks';
import { runTool, toolDefs } from './tools';
import { GeminiProvider } from './llm/gemini';
import { GroqProvider } from './llm/groq';

const MAX_STEPS = 5;

const SYSTEM_PROMPT = [
  'You are a personal execution agent. Keep replies short and actionable.',
  'Manage the user\u2019s tasks with the available tools: multi-task messages decompose into discrete operations.',
  'Undated ideas stay in the inbox (omit scheduled_date); only date what is actually scheduled.',
].join(' ');

/** Session /model pref wins; env LLM_PROVIDER is the global default. */
async function selectProvider(env: Env, sessionId: string) {
  let name = env.LLM_PROVIDER === 'groq' ? 'groq' : 'gemini';
  if (env.SESSIONS) {
    const pref = (await (env.SESSIONS as KVNamespace)
      .get(`llm:${sessionId}`, 'json')
      .catch((): null => null)) as { provider?: string } | null;
    if (pref?.provider === 'groq' || pref?.provider === 'gemini') name = pref.provider;
  }
  return name === 'groq' ? new GroqProvider(env) : new GeminiProvider(env);
}

/** Compaction summarizer: folds overflow messages into the rolling summary. */
async function summarize(
  generate: (system: string, messages: ChatMessage[]) => Promise<string>,
  removed: ChatMessage[],
): Promise<string> {
  return generate(
    'Summarize these chat messages in 5-10 lines, preserving tasks, decisions, and open loops.',
    [{ role: 'user', content: JSON.stringify(removed) }],
  );
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

    const llm = await selectProvider(env, incoming.sessionId);
    const generateText = async (system: string, messages: ChatMessage[]): Promise<string> =>
      (await llm.generate(system, messages, [])).text;
    const sessions = new SessionManager(
      env.SESSIONS as KVNamespace,
      (removed) => summarize(generateText, removed),
    );
    const history = dropOrphans(await sessions.getHistory(incoming.sessionId));
    const summary = await sessions.getSummary(incoming.sessionId);

    const system = [`${SYSTEM_PROMPT} Today is ${new Date().toISOString().slice(0, 10)}.`];
    if (summary) system.push(`Conversation so far: ${summary}`);
    const systemText = system.join('\n\n');

    const userMsg: ChatMessage = { role: 'user', content: incoming.text };
    const transcript: ChatMessage[] = [...history, userMsg];
    const fresh: ChatMessage[] = [userMsg];

    let reply = '';
    for (let step = 0; step < MAX_STEPS; step++) {
      const { text, calls } = await llm.generate(systemText, transcript, toolDefs);
      if (calls.length === 0) {
        reply = text;
        const msg: ChatMessage = { role: 'assistant', content: reply };
        transcript.push(msg);
        fresh.push(msg);
        break;
      }
      const assistantMsg: ChatMessage = { role: 'assistant', content: text || null, tool_calls: calls };
      transcript.push(assistantMsg);
      fresh.push(assistantMsg);
      for (const call of calls) {
        let result: unknown;
        try {
          result = await runTool(call.name, call.args, env);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        const toolMsg: ChatMessage = { role: 'tool', name: call.name, content: JSON.stringify(result), tool_call_id: call.id };
        transcript.push(toolMsg);
        fresh.push(toolMsg);
      }
    }
    if (!reply) {
      reply = (await generateText(systemText, transcript)) || 'Done.';
      fresh.push({ role: 'assistant', content: reply });
    }

    await sessions.appendMessages(incoming.sessionId, fresh);
    if (eventId) await markEvent(env, eventId, 'processed');
    return { sessionId: incoming.sessionId, text: reply, clientType: incoming.clientType, format: 'plain', suggestedActions: ['/today', '/inbox', '/all', '/model'] };
  } catch (err) {
    if (eventId) await markEvent(env, eventId, 'failed').catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    return fail('AGENT_FAILED', message, 'Sorry, I hit a snag — please try again.');
  }
}
