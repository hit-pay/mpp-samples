import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { config } from 'dotenv'
import { liveTransfer, mockTransfer, type Beneficiary } from './lib/hitpay-payouts.ts'
import { createStripeMpp } from './lib/stripe-mpp.ts'

config()

const PORT = Number(process.env.PORT?.trim() || '4002')
const PAYOUT_MOCK = (process.env.HITPAY_PAYOUT_MOCK?.trim() || '1') === '1'
const BANK_HOLDER = process.env.SG_AGENT_BANK_HOLDER?.trim() || 'AI SG Agent'
const BANK_SWIFT = process.env.SG_AGENT_BANK_SWIFT?.trim() || 'DBSSSGSGXXX'
const BANK_ACCOUNT = process.env.SG_AGENT_BANK_ACCOUNT?.trim() || '1234567890'

const FX_USD_TO_SGD = 1.35
const FX_SPREAD = 0 // 0% for clean round numbers; bump to 0.005 for a "real" 0.5% desk fee

interface ApiProvider {
  name: string
  paynow: string
  amount_sgd: string
}
// Three Singapore-based recipients the western agent settles in one batch.
// Amounts kept faucet-friendly (~$200 USDC total).
const PROVIDERS: ApiProvider[] = [
  { name: 'TranslateSG (translation API)', paynow: '+65 9123 4567', amount_sgd: '67.50' },
  { name: 'ACRALookup (KYB / company data)', paynow: '+65 9234 5678', amount_sgd: '135.00' },
  { name: 'PostalSG (address validation)', paynow: '+65 9345 6789', amount_sgd: '67.50' },
]

const TOTAL_SGD = PROVIDERS.reduce((s, c) => s + Number(c.amount_sgd), 0)
const TOTAL_USDC = ((TOTAL_SGD / FX_USD_TO_SGD) * (1 + FX_SPREAD)).toFixed(2)

const stripe = createStripeMpp()
const transferFn = PAYOUT_MOCK ? mockTransfer : liveTransfer

const app = new Hono()

app.get('/', (c) =>
  c.json({
    service: 'disburse-payroll',
    description: 'Cross-rail. Stripe MPP USDC charge → batch HitPay /v1/transfers SGD via FAST.',
    fx: { usd_to_sgd: FX_USD_TO_SGD, spread: FX_SPREAD },
    payout_mode: PAYOUT_MOCK ? 'mock' : 'live-sandbox',
    recipients: PROVIDERS,
    totals: { sgd: TOTAL_SGD.toFixed(2), usdc: TOTAL_USDC },
    endpoints: {
      'GET /payroll': `Stripe MPP $${TOTAL_USDC} USDC → ${PROVIDERS.length}× HitPay Transfers totaling S$${TOTAL_SGD.toFixed(2)}`,
    },
  }),
)

const payroll = stripe.protect(
  {
    amount: TOTAL_USDC,
    currency: 'usd',
    description: `Settle ${PROVIDERS.length} SG recipients @ S$${TOTAL_SGD.toFixed(2)}`,
  },
  async () => {
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder()
        const send = (event: string, data: Record<string, unknown>) => {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        }
        try {
          send('stripe-verified', { amount_usdc: TOTAL_USDC })
          send('fx-quote', {
            usdc_in: TOTAL_USDC,
            sgd_out: TOTAL_SGD.toFixed(2),
            rate: FX_USD_TO_SGD,
            spread_pct: FX_SPREAD * 100,
          })
          send('batch-start', { providers: PROVIDERS, mode: PAYOUT_MOCK ? 'mock' : 'live-sandbox' })

          const results: Array<{ name: string; transfer_id: string; status: string }> = []
          for (const c of PROVIDERS) {
            send('transfer-start', { name: c.name, paynow: c.paynow, amount: c.amount_sgd })
            const beneficiary: Beneficiary = {
              country: 'sg',
              transfer_method: 'bank_transfer',
              transfer_type: 'local',
              currency: 'sgd',
              holder_type: 'individual',
              holder_name: c.name,
              bank_swift_code: BANK_SWIFT,
              account_number: BANK_ACCOUNT,
            }
            const t0 = Date.now()
            try {
              const r = await transferFn({ amount: c.amount_sgd, currency: 'sgd', beneficiary })
              send('transfer-done', {
                name: c.name,
                transfer_id: r.id,
                status: r.status,
                fee: r.total_fee,
                took_ms: Date.now() - t0,
                mocked: r.mocked,
              })
              results.push({ name: c.name, transfer_id: r.id, status: r.status })
            } catch (e) {
              send('transfer-failed', {
                name: c.name,
                error: e instanceof Error ? e.message : String(e),
                took_ms: Date.now() - t0,
              })
            }
          }

          send('batch-done', { count: results.length, total_sgd: TOTAL_SGD.toFixed(2), total_usdc: TOTAL_USDC })
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

app.get('/payroll', (c) => payroll(c.req.raw))

void BANK_HOLDER // currently informational; could become per-recipient default in PROVIDERS

serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
  console.log(`[disburse-payroll] listening on http://localhost:${port}`)
  console.log(`[disburse-payroll] FX 1 USD = ${FX_USD_TO_SGD} SGD · payout mode: ${PAYOUT_MOCK ? 'mock' : 'live-sandbox'}`)
})
