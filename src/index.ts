import { Hono } from 'hono'
import type { Env } from './types/client'
import { TelegramAdapter } from './adapters/telegram'
import { HttpRestAdapter } from './adapters/http-api'
import { runAgentLoop } from './agent'
import { handleCron } from './cron'

const app = new Hono<{ Bindings: Env }>()

app.get('/', (c) => {
  return c.json({ status: 'ok', message: 'Hello from Hono on Workers!' })
})

app.get('/health', (c) => {
  return c.json({ status: 'ok' })
})

// 1. Telegram client webhook
app.post('/webhook/telegram', async (c) => {
  const adapter = new TelegramAdapter()
  const incoming = await adapter.parseIncoming(c.req.raw, c.env)
  if (!incoming) return c.text('OK')

  const outgoing = await runAgentLoop(incoming, c.env)
  await adapter.sendOutgoing(outgoing, c.env)
  return c.text('OK')
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
