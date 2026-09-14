// Normalized messaging layer: core agent logic knows nothing about
// Telegram / HTTP schemas. Adapters translate to/from these types.

// Wrangler bindings (KV, D1, secrets, vars). Extend as bindings are added,
// e.g. `DB: D1Database;`.
export type Env = {
  SESSIONS?: KVNamespace;
  DB?: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  ALLOWED_USER_ID?: string;
  API_TOKEN?: string;
  GEMINI_API_KEY?: string;
  [binding: string]: unknown;
};

export type ClientType = 'telegram' | 'web' | 'cli' | 'cron';

// Future-proof attachment envelope. Unused by Phase 1 text flows,
// but prevents a breaking change when media support lands.
export type MessageAttachment = {
  kind: 'image' | 'file' | 'audio' | 'video' | 'url';
  url?: string;
  mimeType?: string;
  filename?: string;
  /** Small inline payloads (base64). Prefer `url` for large files. */
  data?: string;
};

// Optional cross-cutting metadata. Index signature allows new clients
// to pass extra context without changing the interfaces.
export type MessageMetadata = {
  messageId?: string;
  /** ISO-8601 timestamp of when the message was received/created. */
  timestamp?: string;
  locale?: string;
  [key: string]: unknown;
};

export type IncomingMessage = {
  sessionId: string;
  userId: string;
  text: string;
  clientType: ClientType;
  rawPayload?: unknown;
  attachments?: MessageAttachment[];
  metadata?: MessageMetadata;
};

export type OutgoingMessage = {
  sessionId: string;
  text: string;
  clientType: ClientType;
  format?: 'markdown' | 'plain' | 'html';
  suggestedActions?: string[];
  media?: MessageAttachment[];
  metadata?: MessageMetadata;
  /** Structured failure instead of throwing across adapter boundaries. */
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
};

export interface ClientAdapter {
  name: string;
  parseIncoming(request: Request, env: Env): Promise<IncomingMessage | null>;
  sendOutgoing(message: OutgoingMessage, env: Env): Promise<Response | void>;
}
