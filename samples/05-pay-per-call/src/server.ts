import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { config } from 'dotenv'
import { mockTransfer, type Beneficiary } from './lib/hitpay-payouts.ts'
import { createStripeMpp } from './lib/stripe-mpp.ts'
import { append, listAll, markSwept, pendingByService } from './lib/ledger.ts'

config()

const PORT = Number(process.env.PORT?.trim() || '4002')
const SG_PORT = Number(process.env.SG_RECEIVER_PORT?.trim() || '4001')
const SG_BASE = `http://localhost:${SG_PORT}`
const INTERNAL_API_KEY = process.env.SG_INTERNAL_API_KEY?.trim() || 'sg-internal-demo-key'
const BANK_SWIFT = process.env.SG_AGENT_BANK_SWIFT?.trim() || 'DBSSSGSGXXX'
const BANK_ACCOUNT = process.env.SG_AGENT_BANK_ACCOUNT?.trim() || '1234567890'

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

const stripe = createStripeMpp()

const app = new Hono()

app.get('/', (c) =>
  c.json({
    service: 'pay-per-call',
    description: 'Per-call USDC settlement on Tempo. Each /pay-per-call hit appends one ledger row tagged pay_per_call. SGD payout deferred to /eod-sweep (always mocked).',
    services: Object.fromEntries(
      Object.entries(SERVICES).map(([id, s]) => [
        id,
        { paynow: s.paynow, bank_holder: s.bankHolder, usdc_per_call: s.usdc_per_call, sgd_per_call: s.sgd_per_call },
      ]),
    ),
    endpoints: {
      'GET /pay-per-call/:service?text=...': 'Per-call USDC settlement on Tempo. Forwards to the SG provider, appends one ledger row tagged pay_per_call.',
      'GET /eod-sweep': 'MOCKED end-of-day batch payout for unswept PAY-PER-CALL entries. Always mockTransfer — never hits real /v1/transfers.',
      'GET /ledger': 'Inspect ledger state — entries + per-service unswept SGD.',
    },
  }),
)

// Each /pay-per-call hit charges svc.usdc_per_call via Stripe MPP (real on-chain
// settlement to TEMPO_RECIPIENT), writes one ledger row tagged 'pay_per_call',
// then forwards to the SG seller's upstream service.
function payPerCallHandlerFor(serviceId: string) {
  const svc = SERVICES[serviceId]
  if (!svc) throw new Error(`unknown service: ${serviceId}`)
  return stripe.protect(
    { amount: svc.usdc_per_call, currency: 'usd', description: `1 call @ ${serviceId} (pay-per-use)` },
    async (req) => {
      const entry = append({
        service: serviceId,
        calls: 1,
        usdc_charged: svc.usdc_per_call,
        sgd_owed: svc.sgd_per_call,
        source: 'pay_per_call',
      })
      const url = new URL(req.url)
      const upstreamRes = await fetch(`${svc.upstream}${url.search}`, {
        method: 'GET',
        headers: { 'x-internal-api-key': INTERNAL_API_KEY },
      })
      const body = await upstreamRes.text()
      return new Response(body, {
        status: upstreamRes.status,
        headers: {
          'content-type': upstreamRes.headers.get('content-type') ?? 'application/json',
          'x-usdc-charged': svc.usdc_per_call,
          'x-sgd-owed': svc.sgd_per_call,
          'x-ledger-entry': entry.id,
        },
      })
    },
  )
}

app.get('/pay-per-call/:service', (c) => {
  const id = c.req.param('service')
  if (!SERVICES[id]) {
    return c.json({ error: 'unknown_service', service: id, available: Object.keys(SERVICES) }, 404)
  }
  return payPerCallHandlerFor(id)(c.req.raw)
})

app.get('/ledger', (c) =>
  c.json({
    pending_by_service: pendingByService(),
    entries: listAll(),
  }),
)

app.get('/eod-sweep', () => {
  const buckets = pendingByService({ source: 'pay_per_call' })
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      const send = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }
      try {
        const totalSgd = buckets.reduce((s, b) => s + Number(b.total_sgd), 0).toFixed(2)
        console.log(`[eod-sweep] mocked settlement — ${buckets.length} services, S$${totalSgd}`)
        send('sweep-start', {
          providers: buckets.length,
          mode: 'mock-eod',
          total_sgd: totalSgd,
        })
        if (buckets.length === 0) {
          send('sweep-empty', { message: 'no unswept pay_per_call entries' })
          send('sweep-done', { count: 0, total_sgd: '0.00' })
          controller.close()
          return
        }
        let okCount = 0
        let runningSgd = 0
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
            const r = await mockTransfer({ amount: b.total_sgd, currency: 'sgd', beneficiary })
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
            runningSgd += Number(b.total_sgd)
          } catch (e) {
            send('transfer-failed', {
              service: b.service,
              error: e instanceof Error ? e.message : String(e),
              took_ms: Date.now() - t0,
            })
          }
        }
        send('sweep-done', { count: okCount, total_sgd: runningSgd.toFixed(2) })
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
  console.log(`[pay-per-call] listening on http://localhost:${port}`)
  console.log(`[pay-per-call] sg upstream: ${SG_BASE}`)
})
