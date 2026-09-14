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
  switch (cmd) {
    case '/today':
      text = format(await listToday(env), 'Nothing scheduled today.');
      break;
    case '/inbox':
      text = format(await listInbox(env), 'Inbox is empty.');
      break;
    case '/all':
      text = format(await listOpen(env), 'No open tasks.');
      break;
    default:
      text = 'Commands: /today /inbox /all';
      break;
  }
  if (eventId) await markEvent(env, eventId, 'processed').catch(() => {});
  return { sessionId: incoming.sessionId, text, clientType: incoming.clientType, format: 'plain' };
}
