import { Hono } from 'hono'
import type { Env, IncomingMessage } from './types/client'
import { TelegramAdapter } from './adapters/telegram'
import { HttpRestAdapter } from './adapters/http-api'
import { logEvent, markEvent } from './db/tasks'
import { runAgentLoop } from './agent'
import { handleCommand } from './commands'
import { handleCron } from './cron'

const app = new Hono<{ Bindings: Env }>()

// Thin request/response line for every hit.
app.use('*', async (c, next) => {
  const start = Date.now()
  await next()
  console.log(JSON.stringify({ method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start }))
})

// Top-level errors: console + failed event row, then a safe 500.
app.onError(async (err, c) => {
  console.error(JSON.stringify({ level: 'error', method: c.req.method, path: c.req.path, message: err.message }))
  try {
    const id = await logEvent(c.env, `${c.req.method} ${c.req.path}: ${err.message}`, 'worker')
    await markEvent(c.env, id, 'failed')
  } catch {}
  return c.text('Internal error', 500)
})

app.get('/', (c) => {
  return c.json({ status: 'ok', message: 'Hello from Hono on Workers!' })
})

app.get('/health', (c) => {
  return c.json({ status: 'ok' })
})

/** Slow agent path: typing stays alive while the loop runs, then reply. */
async function processTelegram(adapter: TelegramAdapter, incoming: IncomingMessage, env: Env): Promise<void> {
  await adapter.sendChatAction(incoming.sessionId, env)
  const typing = setInterval(() => {
    void adapter.sendChatAction(incoming.sessionId, env)
  }, 4000)
  try {
    const outgoing = await runAgentLoop(incoming, env)
    await adapter.sendOutgoing(outgoing, env)
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', path: '/webhook/telegram', message: err instanceof Error ? err.message : String(err) }))
  } finally {
    clearInterval(typing)
  }
}

// 1. Telegram client webhook (synchronous: background tasks don't survive here)
app.post('/webhook/telegram', async (c) => {
  const adapter = new TelegramAdapter()
  const incoming = await adapter.parseIncoming(c.req.raw, c.env)
  if (!incoming) return c.text('OK')

  // Fast slash commands bypass the agent loop entirely.
  if (incoming.text.startsWith('/')) {
    const reply = await handleCommand(incoming, c.env)
    if (reply) await adapter.sendOutgoing(reply, c.env)
    return c.text('OK')
  }

  await processTelegram(adapter, incoming, c.env)
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
