// Stub SG upstream service. Three internal-key-authenticated endpoints that
// the prepaid-credits server forwards drawdown calls to.

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { config } from 'dotenv'

config()

const SG_PORT = Number(process.env.SG_RECEIVER_PORT?.trim() || '4001')
const INTERNAL_API_KEY = process.env.SG_INTERNAL_API_KEY?.trim() || 'sg-internal-demo-key'

function authed(c: { req: { header: (k: string) => string | undefined } }) {
  return c.req.header('x-internal-api-key') === INTERNAL_API_KEY
}

const app = new Hono()

app.get('/api/v1/translate', (c) => {
  if (!authed(c)) return c.json({ error: 'unauthorized' }, 401)
  const text = c.req.query('text') ?? 'hello world'
  return c.json({
    service: 'translate',
    input: text,
    output: `${text.toUpperCase()} lah`,
    served_at: new Date().toISOString(),
  })
})

app.get('/api/v1/summarize', (c) => {
  if (!authed(c)) return c.json({ error: 'unauthorized' }, 401)
  const text = c.req.query('text') ?? 'hello world'
  const words = text.trim().split(/\s+/)
  const summary = words.length <= 6 ? text : `${words.slice(0, 3).join(' ')}… ${words.slice(-3).join(' ')}`
  return c.json({
    service: 'summarize',
    input: text,
    output: `tl;dr: ${summary}`,
    served_at: new Date().toISOString(),
  })
})

app.get('/api/v1/sentiment', (c) => {
  if (!authed(c)) return c.json({ error: 'unauthorized' }, 401)
  const text = c.req.query('text') ?? 'hello world'
  const lower = text.toLowerCase()
  const pos = /\b(good|great|love|amazing|happy|win|excellent|nice)\b/.test(lower)
  const neg = /\b(bad|hate|terrible|sad|loss|awful|broken|bug)\b/.test(lower)
  const label = pos && !neg ? 'positive' : neg && !pos ? 'negative' : 'neutral'
  return c.json({
    service: 'sentiment',
    input: text,
    output: { label, confidence: 0.87 },
    served_at: new Date().toISOString(),
  })
})

serve({ fetch: app.fetch, port: SG_PORT }, ({ port }) =>
  console.log(`[sg-receiver] listening on http://localhost:${port}`),
)
