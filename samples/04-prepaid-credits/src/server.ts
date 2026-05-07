import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { config } from 'dotenv'
import { consume, inspect, issue } from './lib/credits.ts'
import { liveTransfer, mockTransfer, type Beneficiary } from './lib/hitpay-payouts.ts'
import { createStripeMpp } from './lib/stripe-mpp.ts'
import { append, listAll, markSwept, pendingByService } from './lib/ledger.ts'

config()

const PORT = Number(process.env.PORT?.trim() || '4002')
const SG_PORT = Number(process.env.SG_RECEIVER_PORT?.trim() || '4001')
const SG_BASE = `http://localhost:${SG_PORT}`
const PAYOUT_MOCK = (process.env.HITPAY_PAYOUT_MOCK?.trim() || '1') === '1'
const INTERNAL_API_KEY = process.env.SG_INTERNAL_API_KEY?.trim() || 'sg-internal-demo-key'
const BANK_SWIFT = process.env.SG_AGENT_BANK_SWIFT?.trim() || 'DBSSSGSGXXX'
const BANK_ACCOUNT = process.env.SG_AGENT_BANK_ACCOUNT?.trim() || '1234567890'

const FX_USD_TO_SGD = 1.35
const FX_SPREAD = 0

interface ServiceConfig {
  paynow: string
  bankHolder: string
  upstream: string
  usdc_per_call: string
  sgd_per_call: string
}

const SERVICES: Record<string, ServiceConfig> = {
  translate: {
    paynow: '+65 9123 4567',
    bankHolder: 'TranslateSG (translation API)',
    upstream: `${SG_BASE}/api/v1/translate`,
    usdc_per_call: '0.50',
    sgd_per_call: '0.65',
  },
  summarize: {
    paynow: '+65 8123 4567',
    bankHolder: 'SummarizeSG (summarization API)',
    upstream: `${SG_BASE}/api/v1/summarize`,
    usdc_per_call: '0.40',
    sgd_per_call: '0.54',
  },
  sentiment: {
    paynow: '+65 7123 4567',
    bankHolder: 'SentimentSG (sentiment API)',
    upstream: `${SG_BASE}/api/v1/sentiment`,
    usdc_per_call: '0.30',
    sgd_per_call: '0.40',
  },
}

const DEFAULT_CALLS = 5
const MAX_CALLS_PER_TOPUP = 1000

const stripe = createStripeMpp()
const transferFn = PAYOUT_MOCK ? mockTransfer : liveTransfer

const app = new Hono()

app.get('/', (c) =>
  c.json({
    service: 'prepaid-credits',
    description: 'Topup → drawdown → sweep. Pay USDC for N prepaid calls; SGD payout deferred to /sweep (one HitPay transfer per service).',
    fx: { usd_to_sgd: FX_USD_TO_SGD, spread: FX_SPREAD },
    payout_mode: PAYOUT_MOCK ? 'mock' : 'live-sandbox',
    services: Object.fromEntries(
      Object.entries(SERVICES).map(([id, s]) => [
        id,
        { paynow: s.paynow, bank_holder: s.bankHolder, usdc_per_call: s.usdc_per_call, sgd_per_call: s.sgd_per_call },
      ]),
    ),
    endpoints: {
      'GET /topup/:service?calls=N': `Pay USDC for N prepaid calls. Issues a credit token; appends one ledger row. Default calls=${DEFAULT_CALLS}.`,
      'GET /proxy/:service?text=...': 'Authenticated drawdown — present credit token via Authorization: Bearer cred_..., we forward to the SG provider.',
      'GET /ledger': 'Inspect ledger state — entries + per-service unswept SGD.',
      'GET /sweep': 'Real /v1/transfers per provider for unswept TOPUP entries (mode controlled by HITPAY_PAYOUT_MOCK).',
    },
  }),
)

function parseCalls(req: Request): number {
  const raw = new URL(req.url).searchParams.get('calls')
  if (!raw) return DEFAULT_CALLS
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CALLS
  return Math.min(n, MAX_CALLS_PER_TOPUP)
}

function topupHandlerFor(serviceId: string, calls: number) {
  const svc = SERVICES[serviceId]
  if (!svc) throw new Error(`unknown service: ${serviceId}`)
  const usdc = (Number(svc.usdc_per_call) * calls).toFixed(2)
  const sgd = (Number(svc.sgd_per_call) * calls).toFixed(2)

  return stripe.protect(
    { amount: usdc, currency: 'usd', description: `${calls} prepaid calls @ ${serviceId}` },
    async () => {
      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder()
          const send = (event: string, data: Record<string, unknown>) => {
            controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
          }
          try {
            send('stripe-verified', { amount_usdc: usdc, calls, service: serviceId })
            send('fx-quote', { usdc_in: usdc, sgd_out: sgd, rate: FX_USD_TO_SGD, spread_pct: FX_SPREAD * 100 })

            const entry = append({ service: serviceId, calls, usdc_charged: usdc, sgd_owed: sgd, source: 'topup' })
            send('ledger-appended', {
              entry_id: entry.id,
              service: serviceId,
              sgd_owed: sgd,
              note: 'SGD payout deferred to /sweep',
            })

            const { token } = issue(serviceId, calls, entry.id)
            send('credit-issued', {
              credit_token: token,
              calls_remaining: calls,
              service: serviceId,
            })
          } catch (e) {
            send('error', { message: e instanceof Error ? e.message : String(e) })
          } finally {
            controller.close()
          }
        },
      })
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
      })
    },
  )
}

app.get('/topup/:service', (c) => {
  const id = c.req.param('service')
  if (!SERVICES[id]) {
    return c.json({ error: 'unknown_service', service: id, available: Object.keys(SERVICES) }, 404)
  }
  const calls = parseCalls(c.req.raw)
  return topupHandlerFor(id, calls)(c.req.raw)
})

// Drawdown: present a Bearer credit_token, server consumes 1 from the credit
// and forwards the rest of the request to the SG service.
app.get('/proxy/:service', async (c) => {
  const id = c.req.param('service')
  const svc = SERVICES[id]
  if (!svc) return c.json({ error: 'unknown_service' }, 404)
  const auth = c.req.header('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return c.json({ error: 'missing_credential', hint: 'Authorization: Bearer cred_...' }, 401)
  const credit = inspect(token)
  if (!credit) return c.json({ error: 'unknown_token' }, 401)

  const result = consume(token, id)
  if (!result.ok) return c.json({ error: result.reason, service: id }, 402)

  const url = new URL(c.req.url)
  const upstream = await fetch(`${svc.upstream}${url.search}`, {
    headers: { 'x-internal-api-key': INTERNAL_API_KEY },
  })
  const body = await upstream.text()
  return new Response(body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'x-credit-remaining': String(result.remaining),
    },
  })
})

app.get('/ledger', (c) =>
  c.json({
    pending_by_service: pendingByService(),
    entries: listAll(),
  }),
)

app.get('/sweep', () => {
  const buckets = pendingByService({ source: 'topup' })
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      const send = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }
      try {
        send('sweep-start', {
          providers: buckets.length,
          mode: PAYOUT_MOCK ? 'mock' : 'live-sandbox',
          total_sgd: buckets.reduce((s, b) => s + Number(b.total_sgd), 0).toFixed(2),
        })
        if (buckets.length === 0) {
          send('sweep-empty', { message: 'no unswept ledger entries' })
          send('sweep-done', { count: 0, total_sgd: '0.00' })
          controller.close()
          return
        }

        let okCount = 0
        let totalSgd = 0
        for (const b of buckets) {
          const svc = SERVICES[b.service]
          if (!svc) {
            send('sweep-skip', { service: b.service, reason: 'service_not_in_catalog' })
            continue
          }
          send('transfer-start', {
            service: b.service,
            bank_holder: svc.bankHolder,
            paynow: svc.paynow,
            amount_sgd: b.total_sgd,
            entries: b.entry_count,
            calls: b.total_calls,
          })
          const beneficiary: Beneficiary = {
            country: 'sg',
            transfer_method: 'bank_transfer',
            transfer_type: 'local',
            currency: 'sgd',
            holder_type: 'individual',
            holder_name: svc.bankHolder,
            bank_swift_code: BANK_SWIFT,
            account_number: BANK_ACCOUNT,
          }
          const t0 = Date.now()
          try {
            const r = await transferFn({ amount: b.total_sgd, currency: 'sgd', beneficiary })
            markSwept(b.entry_ids, r.id)
            send('transfer-done', {
              service: b.service,
              transfer_id: r.id,
              status: r.status,
              fee: r.total_fee,
              took_ms: Date.now() - t0,
              mocked: r.mocked,
              entries_swept: b.entry_count,
              amount_sgd: b.total_sgd,
            })
            okCount += 1
            totalSgd += Number(b.total_sgd)
          } catch (e) {
            send('transfer-failed', {
              service: b.service,
              error: e instanceof Error ? e.message : String(e),
              took_ms: Date.now() - t0,
            })
          }
        }
        send('sweep-done', { count: okCount, total_sgd: totalSgd.toFixed(2) })
      } catch (e) {
        send('error', { message: e instanceof Error ? e.message : String(e) })
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
  })
})

serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
  console.log(`[prepaid-credits] listening on http://localhost:${port}`)
  console.log(`[prepaid-credits] sg upstream: ${SG_BASE} · payout mode: ${PAYOUT_MOCK ? 'mock' : 'live-sandbox'}`)
})
