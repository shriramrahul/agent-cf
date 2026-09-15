import type { Env, IncomingMessage, OutgoingMessage } from './types/client';
import { listInbox, listOpen, listToday, logEvent, markEvent, type TaskRow } from './db/tasks';

function format(tasks: TaskRow[], empty: string): string {
  if (tasks.length === 0) return empty;
  return tasks
    .map((t) => `- [${t.slot}] ${t.title}${t.scheduled_date ? ` (${t.scheduled_date})` : ''}`)
    .join('\n');
}

/**
 * Fast slash commands: answer straight from D1, no agent loop.
 * Returns null when the message is not a command.
 */
export async function handleCommand(incoming: IncomingMessage, env: Env): Promise<OutgoingMessage | null> {
  const cmd = incoming.text.split(' ')[0].split('@')[0].toLowerCase();
  if (!cmd.startsWith('/')) return null;

  const eventId = await logEvent(env, incoming.text, incoming.clientType).catch((): null => null);
  let text: string;
  let actions = ['/today', '/inbox', '/all', '/model'];
  switch (cmd) {
    case '/today':
      text = format(await listToday(env), 'Nothing scheduled today.');
      actions = ['/inbox', '/all', '/model'];
      break;
    case '/inbox':
      text = format(await listInbox(env), 'Inbox is empty.');
      actions = ['/today', '/all', '/model'];
      break;
    case '/all':
      text = format(await listOpen(env), 'No open tasks.');
      actions = ['/today', '/inbox', '/model'];
      break;
    case '/model': {
      text = await handleModelSwitch(incoming, env);
      break;
    }
    default:
      text = 'Commands: /today /inbox /all /model';
      break;
  }
  if (eventId) await markEvent(env, eventId, 'processed').catch(() => {});
  return { sessionId: incoming.sessionId, text, clientType: incoming.clientType, format: 'plain', suggestedActions: actions };
}

/** Per-session LLM switch. Session pref beats the LLM_PROVIDER env default. */
export async function handleModelSwitch(incoming: IncomingMessage, env: Env): Promise<string> {
  const arg = incoming.text.split(' ')[1]?.toLowerCase();
  const kv = env.SESSIONS as KVNamespace | undefined;
  if (!kv) return 'Session store is not configured yet.';
  const stored = (await kv.get(`llm:${incoming.sessionId}`, 'json').catch((): null => null)) as {
    provider?: string;
  } | null;
  const current = stored?.provider ?? (env.LLM_PROVIDER === 'groq' ? 'groq' : 'gemini');
  if (!arg) return `Model: ${current} (usage: /model gemini|groq)`;
  if (arg !== 'gemini' && arg !== 'groq') return 'Usage: /model gemini|groq';
  await kv.put(`llm:${incoming.sessionId}`, JSON.stringify({ provider: arg }), {
    expirationTtl: 60 * 60 * 24 * 30,
  });
  return `Switched to ${arg}.`;
}
