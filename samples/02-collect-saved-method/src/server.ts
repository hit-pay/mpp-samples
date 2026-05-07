import { serve } from '@hono/node-server'
import { buildWwwAuthenticate, createMpp, hashFromRequest, type Price } from '@hit-pay/mpp'
import { Hono } from 'hono'
import { config } from 'dotenv'
import {
  chargeSavedMethod,
  pollSavedMethod,
  setupSavedMethod,
  type SavedPaymentMethod,
} from './lib/mpp-saved-method.ts'
import * as savedMethodStore from './lib/saved-method-store.ts'

config()

function required(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) {
    console.error(`❌ ${name} is required. See .env.template`)
    process.exit(1)
  }
  return v
}

const HITPAY_API_KEY = required('HITPAY_API_KEY')
const HITPAY_WEBHOOK_SALT = required('HITPAY_WEBHOOK_SALT')
const HITPAY_MPP_ENDPOINT = process.env.HITPAY_MPP_ENDPOINT?.trim() || 'https://sandbox.mpp.hitpay.dev'
const PORT = Number(process.env.PORT?.trim() || '4001')

const mpp = createMpp({
  apiKey: HITPAY_API_KEY,
  webhookSalt: HITPAY_WEBHOOK_SALT,
  endpoint: HITPAY_MPP_ENDPOINT,
})

// Same per-market price catalog as sample 01 — what changes here is the
// payment mechanic (saved-method binding instead of one-shot QR).
const PRICE_BY_COUNTRY: Record<string, Price> = {
  sg: { amount: '5.00', currency: 'sgd', description: 'AI tutor session (SG)' },
  my: { amount: '15.00', currency: 'myr', description: 'AI tutor session (MY)' },
  id: { amount: '50000', currency: 'idr', description: 'AI tutor session (ID)' },
  ph: { amount: '200.00', currency: 'php', description: 'AI tutor session (PH)' },
  th: { amount: '120.00', currency: 'thb', description: 'AI tutor session (TH)' },
}

// Saved-method matrix. GrabPay (grabpay_direct) and ShopeePay are pan-SEA in
// HitPay MPP today; Touch'n'Go is MY-only. The country drives pricing and
// currency via PRICE_BY_COUNTRY — the saved method changes how the buyer
// pays. Each (currency, method) tuple binds independently in the broker.
const SAVED_METHODS_BY_COUNTRY: Record<string, readonly SavedPaymentMethod[]> = {
  sg: ['grabpay_direct', 'shopee_pay'],
  my: ['grabpay_direct', 'shopee_pay', 'touch_n_go'],
  ph: ['grabpay_direct', 'shopee_pay'],
  id: ['grabpay_direct', 'shopee_pay'],
  th: ['grabpay_direct', 'shopee_pay'],
}

// Cap each silent charge at 10× the per-session price. Buys headroom for
// repeat purchases without letting a stolen-token incident drain the wallet.
function maxAmountPerCharge(price: Price): string {
  const n = Number(price.amount)
  if (Number.isNaN(n)) return price.amount
  return price.currency.toLowerCase() === 'idr' ? String(Math.round(n * 10)) : (n * 10).toFixed(2)
}

const app = new Hono()

app.get('/', (c) =>
  c.json({
    service: 'collect-saved-method',
    description: 'AI tutor service. First hit binds a saved wallet (GrabPay/ShopeePay/Touch\'n\'Go); subsequent hits charge silently.',
    catalog: PRICE_BY_COUNTRY,
    methods_by_country: SAVED_METHODS_BY_COUNTRY,
    endpoints: {
      'GET /tutor-saved?country=&method=': '402 (first hit) → silent charge (subsequent hits). grabpay_direct | shopee_pay | touch_n_go',
      'GET /saved-method': 'List bound saved methods',
      'POST /saved-method/bound': '{ paymentMethod, currency, savedMethodId } — demo helper to mark bound without polling',
      'POST /saved-method/reset?method=&currency=': 'Clear one or all bound methods',
    },
  }),
)

// First hit (no bound method): kick off setup, return 402 with the broker's
// setup_checkout_url, and start polling in the background. Once the buyer
// approves in their wallet, the polling promise writes the saved_method_id
// to savedMethodStore and subsequent hits charge silently.
app.get('/tutor-saved', async (c) => {
  const country = (c.req.query('country') ?? 'sg').toLowerCase()
  const method = (c.req.query('method') ?? '') as SavedPaymentMethod
  const allowed = SAVED_METHODS_BY_COUNTRY[country]
  if (!allowed) return c.json({ error: `unsupported country: ${country}` }, 400)
  if (!method || !allowed.includes(method)) {
    return c.json({ error: `${method || '(none)'} not available in ${country.toUpperCase()}`, allowed }, 400)
  }
  const price = PRICE_BY_COUNTRY[country] ?? PRICE_BY_COUNTRY.sg!

  const bound = savedMethodStore.get(price.currency, method)
  if (bound) {
    const requestHash = hashFromRequest(c.req.raw)
    let charge
    try {
      charge = await chargeSavedMethod({ savedMethodId: bound.savedMethodId, price, requestHash })
    } catch (e) {
      return c.json({ error: 'mpp_charge_failed', detail: e instanceof Error ? e.message : String(e) }, 502)
    }
    console.log(
      `[ai-seller] silent charge ${price.amount} ${price.currency.toUpperCase()} via saved ${method} for ${country.toUpperCase()} buyer`,
    )
    return c.json(
      {
        result: 'tutor session unlocked: lesson_id=lsn_demo',
        market: country,
        paid: { amount: price.amount, currency: price.currency, method, mode: 'silent' },
        settled_at: charge.paid_at,
      },
      200,
      { 'mpp-receipt': charge.receipt_jws },
    )
  }

  let setup
  try {
    setup = await setupSavedMethod({
      paymentMethod: method,
      customerEmail: savedMethodStore.DEMO_BUYER_EMAIL,
      currency: price.currency,
      maxAmountPerCharge: maxAmountPerCharge(price),
      requestHash: hashFromRequest(c.req.raw),
    })
  } catch (e) {
    return c.json({ error: 'mpp_setup_failed', detail: e instanceof Error ? e.message : String(e) }, 502)
  }
  // Background-poll the broker until the buyer approves the wallet bind.
  // On success, write to the in-process store. Errors are logged and ignored —
  // the next /tutor-saved hit will simply re-issue a setup if the bind never
  // completed (broker should return a fresh setup URL for an expired token).
  void (async () => {
    const deadlineMs = Date.now() + 5 * 60_000
    while (Date.now() < deadlineMs) {
      try {
        const res = await pollSavedMethod(setup.saved_method_id)
        if (res.status === 'bound') {
          savedMethodStore.set({
            paymentMethod: method,
            currency: price.currency,
            savedMethodId: res.saved_method_id,
            boundAt: new Date().toISOString(),
          })
          console.log(`[ai-seller] saved method bound: ${price.currency.toUpperCase()}/${method} → ${res.saved_method_id}`)
          return
        }
        if (res.status === 'failed' || res.status === 'expired') {
          console.warn(`[ai-seller] saved method ${method} ${res.status}`)
          return
        }
      } catch (e) {
        console.warn(`[ai-seller] poll error for ${method}: ${e instanceof Error ? e.message : String(e)}`)
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
    console.warn(`[ai-seller] saved method ${method} bind timeout`)
  })()

  const challenge = {
    amount: price.amount,
    currency: price.currency,
    description: `${price.description} — bind ${method}`,
    methodDetails: {
      checkout_url: setup.setup_checkout_url,
      expires_at: setup.expires_at,
      polling_url: setup.polling_url,
    },
  }
  return new Response(
    JSON.stringify({ error: 'payment_required', challenge, mode: 'saved-method-setup', method, country }),
    {
      status: 402,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': buildWwwAuthenticate(challenge),
      },
    },
  )
})

// Demo helper: mark a method bound without waiting on the broker's poll loop.
// Useful when running against a local broker stub or when the sandbox's
// polling endpoint isn't wired up yet.
app.post('/saved-method/bound', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    paymentMethod?: string
    currency?: string
    savedMethodId?: string
  }
  if (!body.paymentMethod || !body.currency || !body.savedMethodId) {
    return c.json({ error: 'paymentMethod, currency, savedMethodId required' }, 400)
  }
  savedMethodStore.set({
    paymentMethod: body.paymentMethod,
    currency: body.currency.toLowerCase(),
    savedMethodId: body.savedMethodId,
    boundAt: new Date().toISOString(),
  })
  return c.json({ ok: true, paymentMethod: body.paymentMethod, currency: body.currency.toLowerCase() })
})

app.get('/saved-method', (c) => c.json({ bound: savedMethodStore.list() }))

app.post('/saved-method/reset', (c) => {
  const method = c.req.query('method') ?? undefined
  const currency = c.req.query('currency') ?? undefined
  savedMethodStore.clear(method || currency ? { paymentMethod: method, currency } : undefined)
  return c.json({ ok: true, cleared: { method: method ?? '*', currency: currency ?? '*' } })
})

serve({ fetch: app.fetch, port: PORT }, ({ port }) =>
  console.log(`[collect-saved-method] listening on http://localhost:${port}`),
)
