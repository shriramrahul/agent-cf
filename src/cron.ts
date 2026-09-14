import type { Env } from './types/client';
import { TelegramAdapter } from './adapters/telegram';
import { listToday } from './db/tasks';

/**
 * Morning brief: today's plan pushed to the owner via Telegram.
 * Single-user bot, so the DM chat id equals the allowed user id.
 * 90-minute WIP nudges and avoidance interventions build on this later.
 */
export async function handleCron(env: Env): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.ALLOWED_USER_ID) return;
  const tasks = await listToday(env);
  const text = tasks.length > 0
    ? `Morning brief (${tasks.length}):\n${tasks.map((t) => `- [${t.slot}] ${t.title}`).join('\n')}`
    : 'Nothing scheduled today. Anything in the inbox worth scheduling?';
  await new TelegramAdapter().sendOutgoing(
    { sessionId: `user_${env.ALLOWED_USER_ID}`, text, clientType: 'telegram' },
    env,
  );
}
