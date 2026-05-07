import { serve } from '@hono/node-server'
import { createMpp, type Price } from '@hit-pay/mpp'
import { Hono } from 'hono'
import { config } from 'dotenv'

config()

const HITPAY_API_KEY = required('HITPAY_API_KEY')
const HITPAY_WEBHOOK_SALT = required('HITPAY_WEBHOOK_SALT')
const HITPAY_MPP_ENDPOINT = process.env.HITPAY_MPP_ENDPOINT?.trim() || 'https://sandbox.mpp.hitpay.dev'
const PORT = Number(process.env.PORT?.trim() || '4001')

function required(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) {
    console.error(`❌ ${name} is required. See .env.template`)
    process.exit(1)
  }
  return v
}

const mpp = createMpp({
  apiKey: HITPAY_API_KEY,
  webhookSalt: HITPAY_WEBHOOK_SALT,
  endpoint: HITPAY_MPP_ENDPOINT,
})

// AI seller catalog. One product (an AI tutor session) priced per local market.
// HitPay MPP picks the rail based on currency: PayNow for SGD, FPX for MYR,
// QRIS for IDR, GCash/PayMaya for PHP, PromptPay for THB.
const PRICE_BY_COUNTRY: Record<string, Price> = {
  sg: { amount: '5.00', currency: 'sgd', description: 'AI tutor session (SG · PayNow)' },
  my: { amount: '15.00', currency: 'myr', description: 'AI tutor session (MY · FPX)' },
  id: { amount: '50000', currency: 'idr', description: 'AI tutor session (ID · QRIS)' },
  ph: { amount: '200.00', currency: 'php', description: 'AI tutor session (PH · GCash)' },
  th: { amount: '120.00', currency: 'thb', description: 'AI tutor session (TH · PromptPay)' },
}

function pickPrice(req: Request): Price {
  const country = (new URL(req.url).searchParams.get('country') ?? 'sg').toLowerCase()
  return PRICE_BY_COUNTRY[country] ?? PRICE_BY_COUNTRY.sg!
}

const tutor = mpp.protect(pickPrice, async (req) => {
  const url = new URL(req.url)
  const country = (url.searchParams.get('country') ?? 'sg').toLowerCase()
  const price = PRICE_BY_COUNTRY[country] ?? PRICE_BY_COUNTRY.sg!
  console.log(`[ai-seller] tutor session unlocked for ${country.toUpperCase()} buyer (${price.amount} ${price.currency.toUpperCase()})`)
  return Response.json({
    result: 'tutor session unlocked: lesson_id=lsn_demo',
    market: country,
    paid: { amount: price.amount, currency: price.currency },
    settled_at: new Date().toISOString(),
  })
})

const app = new Hono()

app.get('/', (c) =>
  c.json({
    service: 'ai-seller',
    description: 'AI tutor service. Charges in local SEA currency via HitPay MPP. Pick country with ?country=sg|my|id|ph|th',
    catalog: PRICE_BY_COUNTRY,
    endpoints: {
      '/tutor?country=sg': '402 — S$5.00 PayNow',
      '/tutor?country=my': '402 — RM 15.00 FPX',
      '/tutor?country=id': '402 — Rp 50,000 QRIS',
      '/tutor?country=ph': '402 — ₱200.00 GCash',
      '/tutor?country=th': '402 — ฿120.00 PromptPay',
    },
  }),
)

app.get('/tutor', (c) => tutor(c.req.raw, c))

serve({ fetch: app.fetch, port: PORT }, ({ port }) =>
  console.log(`[collect-oneshot] listening on http://localhost:${port}`),
)
