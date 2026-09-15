import type { ClientAdapter, Env, IncomingMessage, OutgoingMessage } from '../types/client';

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    date: number; // unix seconds
    chat: { id: number };
    from?: { id: number };
    text?: string;
  };
};

/**
 * Telegram transport. Inbound chat_id maps to the shared session
 * `user_${chatId}`, so other clients using the same sessionId share context.
 */
export class TelegramAdapter implements ClientAdapter {
  name = 'telegram';

  async parseIncoming(request: Request, env: Env): Promise<IncomingMessage | null> {
    if (request.method !== 'POST') return null;
    let update: TelegramUpdate;
    try {
      update = (await request.json()) as TelegramUpdate;
    } catch {
      return null;
    }
    const msg = update.message;
    const text = msg?.text;
    const chatId = msg?.chat.id;
    const fromId = msg?.from?.id;
    if (!msg || !text || chatId === undefined || fromId === undefined) return null;

    // Single-user gate: ignore everyone else, but ack 200 upstream.
    if (!env.ALLOWED_USER_ID || String(fromId) !== env.ALLOWED_USER_ID) return null;

    // Idempotency: Telegram redelivers slow webhooks; replays are no-ops.
    if (env.SESSIONS) {
      const seen = await (env.SESSIONS as KVNamespace).get(`tg_update:${update.update_id}`);
      if (seen) return null;
      await (env.SESSIONS as KVNamespace).put(`tg_update:${update.update_id}`, '1', {
        expirationTtl: 60 * 60 * 24,
      });
    }

    return {
      sessionId: `user_${chatId}`,
      userId: String(fromId),
      text,
      clientType: 'telegram',
      rawPayload: update,
      metadata: {
        messageId: String(msg.message_id),
        timestamp: new Date(msg.date * 1000).toISOString(),
      },
    };
  }

  async sendOutgoing(message: OutgoingMessage, env: Env): Promise<void> {
    const token = env.TELEGRAM_BOT_TOKEN as string | undefined;
    if (!token) throw new Error('Telegram binding missing: TELEGRAM_BOT_TOKEN');
    const chatId = message.sessionId.replace(/^user_/, '');
    // Plain text by default: raw LLM markdown is not valid MarkdownV2
    // (unescaped chars break delivery). Only HTML is passed through.
    const body: Record<string, unknown> = { chat_id: chatId, text: message.text };
    if (message.format === 'html') body.parse_mode = 'HTML';
    if (message.suggestedActions && message.suggestedActions.length > 0) {
      body.reply_markup = {
        keyboard: [message.suggestedActions.slice(0, 4)],
        resize_keyboard: true,
        one_time_keyboard: false,
      };
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Telegram send failed: ${res.status}`);
  }

  /** Typing indicator (expires after ~5s, re-fire during long loops). */
  async sendChatAction(sessionId: string, env: Env): Promise<void> {
    const token = env.TELEGRAM_BOT_TOKEN as string | undefined;
    if (!token) return;
    await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: sessionId.replace(/^user_/, ''), action: 'typing' }),
    }).catch(() => {});
  }
}
