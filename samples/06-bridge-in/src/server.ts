import { serve } from '@hono/node-server'
import { MppServiceClient, canonicalRequestHash } from '@hit-pay/mpp'
import { Hono } from 'hono'
import { config } from 'dotenv'
import * as bridgeWaiters from './lib/bridge-waiters.ts'
import { verifyHitpaySignature } from './lib/hitpay-webhook.ts'
import { pollPaymentRequestUntilPaid } from './lib/hitpay-poll.ts'
import { sendUsdcOnTempo } from './lib/tempo-treasury.ts'

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
const HITPAY_API_BASE = process.env.HITPAY_API_BASE?.trim() || 'https://api.sandbox.hit-pay.com'
const PORT = Number(process.env.PORT?.trim() || '4002')
const FX_USD_TO_SGD = Number(process.env.BRIDGE_FX_USD_TO_SGD?.trim() || '1.35')
const POLL_FALLBACK_MS = Number(process.env.BRIDGE_POLL_FALLBACK_MS?.trim() || '300000')

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/

const app = new Hono()

app.get('/', (c) =>
  c.json({
    service: 'bridge-in',
    description: 'Reverse cross-rail. SEA buyer pays SGD via HitPay MPP PayNow; treasury wallet signs USDC transfer on Tempo testnet to recipient.',
    fx: { usd_to_sgd: FX_USD_TO_SGD },
    endpoints: {
      'GET /bridge-in?usd=&recipient=': 'SSE stream — emits bridge-charge (PayNow URL), bridge-paid (when webhook or poll detects payment), bridge-tempo-tx (USDC transfer hash), bridge-done.',
      'POST /webhooks/hitpay': 'HitPay account-level webhook target. HMAC-verified; notifies the in-flight /bridge-in waiter when payment_request.completed fires.',
      'GET /in-flight': 'List reference_numbers awaiting payment confirmation (debug).',
    },
    in_flight: bridgeWaiters.inFlight(),
  }),
)

app.get('/in-flight', (c) => c.json({ in_flight: bridgeWaiters.inFlight() }))

// ─── /bridge-in: PayNow SGD in → USDC on Tempo out ─────────────────────────
app.get('/bridge-in', (c) => {
  const usd = c.req.query('usd') ?? ''
  const recipient = (c.req.query('recipient') ?? '') as `0x${string}`
  const usdNum = Number(usd)
  if (!Number.isFinite(usdNum) || usdNum <= 0) {
    return c.json({ error: 'invalid_usd', detail: 'usd must be a positive number' }, 400)
  }
  if (!ADDR_RE.test(recipient)) {
    return c.json({ error: 'invalid_recipient', detail: 'recipient must be a 0x-prefixed 42-char hex address' }, 400)
  }
  const sgdAmount = (usdNum * FX_USD_TO_SGD).toFixed(2)

  return new Response(
    new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder()
        const send = (event: string, data: Record<string, unknown>) => {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        }
        const t0 = Date.now()
        let challengeId: string | undefined

        try {
          const client = new MppServiceClient(HITPAY_MPP_ENDPOINT, HITPAY_API_KEY, HITPAY_WEBHOOK_SALT)
          const requestHash = canonicalRequestHash({
            method: 'POST',
            path: '/bridge-in',
            query: { usd, recipient },
          })
          const created = await client.createCharge({
            price: {
              amount: sgdAmount,
              currency: 'sgd',
              description: `Bridge $${usdNum.toFixed(2)} USDC → ${recipient}`,
            },
            requestHash,
          })
          challengeId = created.challengeId
          send('bridge-charge', {
            charge_id: created.challengeId,
            checkout_url: created.challenge.methodDetails.checkout_url,
            polling_url: created.challenge.methodDetails.polling_url,
            expires_at: created.challenge.methodDetails.expires_at,
            amount_sgd: sgdAmount,
            currency: 'sgd',
            recipient,
            usd: usdNum.toFixed(2),
            fx: FX_USD_TO_SGD,
          })

          // Race two detection paths:
          //   (a) the dashboard-registered webhook firing for payment_request.completed
          //       on this charge's reference_number (set by the broker to challengeId)
          //   (b) the polling fallback against the underlying HitPay PR
          // Whichever wins resolves the SSE stream.
          const webhookWaiter = bridgeWaiters.register(created.challengeId)
          const pollFallback = pollPaymentRequestUntilPaid(
            created.challenge.methodDetails.checkout_url,
            HITPAY_API_BASE,
            HITPAY_API_KEY,
            Date.now() + POLL_FALLBACK_MS,
          ).then((r) => r.status as 'paid' | 'expired' | 'timeout' | 'not_found')

          const detection = await Promise.race([webhookWaiter, pollFallback])

          if (detection !== 'paid') {
            send('error', { stage: 'detect', status: detection, took_ms: Date.now() - t0 })
            controller.close()
            return
          }
          send('bridge-paid', {
            fiat_received: sgdAmount,
            currency: 'sgd',
            settled_in_ms: Date.now() - t0,
          })

          const tempoRes = await sendUsdcOnTempo({ recipient, amountUsd: usdNum.toFixed(2) })
          send('bridge-tempo-tx', {
            tx_hash: tempoRes.tx_hash,
            block: tempoRes.block.toString(),
            treasury: tempoRes.treasury,
            recipient: tempoRes.recipient,
            usdc: tempoRes.amount_usdc,
            explorer: `https://explorer.moderato.tempo.xyz/tx/${tempoRes.tx_hash}`,
          })
          send('bridge-done', {
            total_ms: Date.now() - t0,
            recipient,
            fiat_in_sgd: sgdAmount,
            usdc_out: usdNum.toFixed(2),
          })
        } catch (e) {
          send('error', { stage: 'fatal', message: e instanceof Error ? e.message : String(e) })
        } finally {
          if (challengeId) bridgeWaiters.cleanup(challengeId)
          controller.close()
        }
      },
    }),
    { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } },
  )
})

// ─── POST /webhooks/hitpay: HMAC-verified webhook receiver ─────────────────
// Register `<your-public-url>/webhooks/hitpay` in the HitPay sandbox dashboard
// (Developers → Webhook Endpoints) and subscribe to `payment_request.completed`.
// HitPay POSTs the raw event JSON; we verify the HMAC, look up the in-flight
// /bridge-in waiter by reference_number (== MPP challengeId), and notify it.
app.post('/webhooks/hitpay', async (c) => {
  const rawBody = await c.req.text()
  const signature = c.req.header('hitpay-signature') || c.req.header('Hitpay-Signature')
  if (!verifyHitpaySignature(rawBody, signature, HITPAY_WEBHOOK_SALT)) {
    console.warn('[webhook] signature verification failed')
    return c.json({ error: 'invalid_signature' }, 401)
  }
  const eventObject = c.req.header('hitpay-event-object') || c.req.header('Hitpay-Event-Object')
  const eventType = c.req.header('hitpay-event-type') || c.req.header('Hitpay-Event-Type')
  let body: Record<string, unknown>
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  const referenceNumber =
    typeof body.reference_number === 'string' ? body.reference_number : undefined

  console.log(`[webhook] ${eventObject}/${eventType} reference=${referenceNumber ?? '(none)'}`)

  if (eventObject === 'payment_request' && eventType === 'completed' && referenceNumber) {
    const matched = bridgeWaiters.notify(referenceNumber, 'paid')
    return c.json({ ok: true, matched_in_flight: matched })
  }
  // Always 200 — HitPay retries on 4xx/5xx. Only 401 if signature invalid.
  return c.json({ ok: true, ignored: true })
})

serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
  console.log(`[bridge-in] listening on http://localhost:${port}`)
  console.log(`[bridge-in] webhook receiver: POST http://localhost:${port}/webhooks/hitpay`)
  console.log(`[bridge-in] FX 1 USD = ${FX_USD_TO_SGD} SGD · poll fallback ${POLL_FALLBACK_MS}ms`)
  if (!process.env.HITPAY_TREASURY_PRIVATE_KEY?.trim() && process.env.TEMPO_PRIVATE_KEY?.trim()) {
    console.log(`[bridge-in] treasury = TEMPO_PRIVATE_KEY wallet (single-key demo mode)`)
  }
})
