import { Hono } from 'hono'

type Bindings = {
  // Add bindings here, e.g. KV, D1, AI, etc.
  // MY_KV: KVNamespace
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) => {
  return c.json({ status: 'ok', message: 'Hello from Hono on Workers!' })
})

app.get('/health', (c) => {
  return c.json({ status: 'ok' })
})

export default app
