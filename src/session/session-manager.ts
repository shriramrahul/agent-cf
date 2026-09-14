export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

const MAX_HISTORY = 20;
const RETENTION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export class SessionManager {
  constructor(private kv: KVNamespace) {}

  async getHistory(sessionId: string): Promise<ChatMessage[]> {
    const raw = await this.kv.get(`session:${sessionId}`, 'json');
    return (raw as ChatMessage[]) || [];
  }

  async appendMessages(sessionId: string, messages: ChatMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const history = await this.getHistory(sessionId);
    // Keep rolling window to stay lightweight
    const updated = [...history, ...messages].slice(-MAX_HISTORY);
    await this.kv.put(`session:${sessionId}`, JSON.stringify(updated), {
      expirationTtl: RETENTION_TTL_SECONDS,
    });
  }

  async clearHistory(sessionId: string): Promise<void> {
    await this.kv.delete(`session:${sessionId}`);
  }
}
