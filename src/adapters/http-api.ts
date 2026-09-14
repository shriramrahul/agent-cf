import type { ClientAdapter, Env, IncomingMessage, OutgoingMessage } from '../types/client';

type ChatBody = {
  sessionId?: string;
  userId?: string;
  text?: string;
};

/**
 * Generic REST transport for thin clients (web/CLI/mobile).
 * Pass the same sessionId as Telegram (`user_<chatId>`) to share context.
 */
export class HttpRestAdapter implements ClientAdapter {
  name = 'http-rest';

  async parseIncoming(request: Request, env: Env): Promise<IncomingMessage | null> {
    if (request.method !== 'POST') return null;
    if (!env.API_TOKEN || request.headers.get('authorization') !== `Bearer ${env.API_TOKEN}`) {
      return null;
    }
    let body: ChatBody;
    try {
      body = (await request.json()) as ChatBody;
    } catch {
      return null;
    }
    if (!body.text || typeof body.text !== 'string') return null;
    const userId = body.userId ?? 'web';
    return {
      sessionId: body.sessionId ?? `user_${userId}`,
      userId,
      text: body.text,
      clientType: 'web',
      rawPayload: body,
    };
  }

  async sendOutgoing(message: OutgoingMessage): Promise<Response> {
    if (message.error) {
      return Response.json({ error: message.error, text: message.text }, { status: 500 });
    }
    return Response.json({
      text: message.text,
      actions: message.suggestedActions ?? [],
      ...(message.media ? { media: message.media } : {}),
    });
  }
}
