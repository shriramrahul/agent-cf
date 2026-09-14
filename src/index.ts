import { Hono } from 'hono'
import type { Env, IncomingMessage } from './types/client'
import { TelegramAdapter } from './adapters/telegram'
import { HttpRestAdapter } from './adapters/http-api'
import { runAgentLoop } from './agent'
import { handleCommand } from './commands'
import { handleCron } from './cron'

const app = new Hono<{ Bindings: Env }>()

app.get('/', (c) => {
  return c.json({ status: 'ok', message: 'Hello from Hono on Workers!' })
})

app.get('/health', (c) => {
  return c.json({ status: 'ok' })
})

/** Slow agent path: ack immediately, keep typing alive, reply when done. */
async function processTelegram(adapter: TelegramAdapter, incoming: IncomingMessage, env: Env): Promise<void> {
  await adapter.sendChatAction(incoming.sessionId, env)
  const typing = setInterval(() => {
    void adapter.sendChatAction(incoming.sessionId, env)
  }, 4000)
  try {
    const outgoing = await runAgentLoop(incoming, env)
    await adapter.sendOutgoing(outgoing, env)
  } finally {
    clearInterval(typing)
  }
}

// 1. Telegram client webhook
app.post('/webhook/telegram', (c) => {
  const adapter = new TelegramAdapter()
  return adapter.parseIncoming(c.req.raw, c.env).then(async (incoming) => {
    if (!incoming) return c.text('OK')

    // Fast slash commands bypass the agent loop entirely.
    if (incoming.text.startsWith('/')) {
      const reply = await handleCommand(incoming, c.env)
      if (reply) await adapter.sendOutgoing(reply, c.env)
      return c.text('OK')
    }

    c.executionCtx.waitUntil(processTelegram(adapter, incoming, c.env))
    return c.text('OK')
  })
})

// 2. Generic HTTP API for thin web/CLI/mobile clients
app.post('/api/chat', async (c) => {
  const adapter = new HttpRestAdapter()
  const incoming = await adapter.parseIncoming(c.req.raw, c.env)
  if (!incoming) return c.text('Unauthorized', 401)

  const outgoing = await runAgentLoop(incoming, c.env)
  return adapter.sendOutgoing(outgoing, c.env)
})

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleCron(env))
  },
}
