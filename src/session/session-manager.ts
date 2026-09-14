export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
};

export type CompactMode = 'summarize' | 'clear';

export type CompactResult = {
  mode: CompactMode;
  /** Summary covering the removed messages, returned BEFORE purging. */
  summary: string | null;
  removed: number;
  kept: number;
};

const MAX_HISTORY = 30;
const DEFAULT_KEEP_LAST = 10;
const RETENTION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export class SessionManager {
  // Summarizer is injected (the LLM call lives in the agent layer).
  // Without one, compaction drops old messages just like before.
  constructor(
    private kv: KVNamespace,
    private summarize?: (removed: ChatMessage[]) => Promise<string>,
  ) {}

  async getHistory(sessionId: string): Promise<ChatMessage[]> {
    const raw = await this.kv.get(`session:${sessionId}`, 'json');
    return (raw as ChatMessage[]) || [];
  }

  async getSummary(sessionId: string): Promise<string | null> {
    return await this.kv.get(`session:${sessionId}:summary`);
  }

  async appendMessages(sessionId: string, messages: ChatMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const history = await this.getHistory(sessionId);
    let updated = [...history, ...messages];

    // Auto-compact: once over budget, fold the oldest messages into
    // the rolling summary and keep only the recent window.
    if (updated.length > MAX_HISTORY) {
      const overflow = updated.slice(0, updated.length - DEFAULT_KEEP_LAST);
      updated = updated.slice(-DEFAULT_KEEP_LAST);
      if (this.summarize) {
        await this.appendSummary(sessionId, await this.summarize(overflow));
      }
    }

    await this.kv.put(`session:${sessionId}`, JSON.stringify(updated), {
      expirationTtl: RETENTION_TTL_SECONDS,
    });
  }

  /**
   * Client-controlled compaction. Returns the summary of removed
   * messages BEFORE purging, so the client sees what is forgotten.
   */
  async compactSession(
    sessionId: string,
    mode: CompactMode,
    keep_last: number = DEFAULT_KEEP_LAST,
  ): Promise<CompactResult> {
    const history = await this.getHistory(sessionId);

    if (mode === 'clear') {
      const summary = await this.getSummary(sessionId);
      await this.clearHistory(sessionId);
      return { mode, summary, removed: history.length, kept: 0 };
    }

    const overflow = history.slice(0, Math.max(0, history.length - keep_last));
    const kept = history.slice(-keep_last);
    let summary = await this.getSummary(sessionId);
    if (overflow.length > 0 && this.summarize) {
      summary = await this.appendSummary(sessionId, await this.summarize(overflow));
    }
    await this.kv.put(`session:${sessionId}`, JSON.stringify(kept), {
      expirationTtl: RETENTION_TTL_SECONDS,
    });
    return { mode, summary, removed: overflow.length, kept: kept.length };
  }

  async clearHistory(sessionId: string): Promise<void> {
    await this.kv.delete(`session:${sessionId}`);
    await this.kv.delete(`session:${sessionId}:summary`);
  }

  /** Merges new summary text onto the stored rolling summary. */
  private async appendSummary(sessionId: string, addition: string): Promise<string> {
    const prev = await this.getSummary(sessionId);
    const next = prev ? `${prev}\n${addition}` : addition;
    await this.kv.put(`session:${sessionId}:summary`, next, {
      expirationTtl: RETENTION_TTL_SECONDS,
    });
    return next;
  }
}
