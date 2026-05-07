// Stripe MPP wrapper — a `protect(price, handler)` decorator that gates an
// HTTP handler behind a USDC-on-Tempo settlement.
//
// Two implementations:
//   - createRealMpp: real Stripe PaymentIntent + mppx Tempo testnet flow
//   - createStubMpp: bypass Stripe entirely; accept "Authorization: Payment stub-..."
//                    headers from a CLI client. Use until Stripe MPP access lands.

import 'dotenv/config'
import crypto from 'node:crypto'
import { Credential } from 'mppx'
import { Mppx, tempo } from 'mppx/server'
import NodeCache from 'node-cache'
import Stripe from 'stripe'

const STRIPE_STUB = (process.env.STRIPE_STUB?.trim() || '1') === '1'
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY?.trim() || ''
const TEMPO_RECIPIENT = (process.env.TEMPO_RECIPIENT?.trim() || '') as `0x${string}` | ''

export type Price = { amount: string; currency: string; description?: string }
export type StripeHandler = (req: Request) => Promise<Response> | Response

export interface StripeMpp {
  protect(price: Price, handler: StripeHandler): StripeHandler
}

// USDC contract address on Tempo testnet (per stripe-samples/machine-payments).
const TEMPO_USDC = '0x20c0000000000000000000000000000000000000' as const

export function createStripeMpp(): StripeMpp {
  if (STRIPE_STUB) {
    console.log('[stripe-mpp] STUB mode (no real Stripe / Tempo)')
    return createStubMpp()
  }
  if (!STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is required when STRIPE_STUB=0')
  }
  console.log('[stripe-mpp] REAL mode (Tempo testnet)')
  return createRealMpp(STRIPE_SECRET_KEY)
}

function createRealMpp(secretKey: string): StripeMpp {
  const stripeClient = new Stripe(secretKey, {
    // @ts-expect-error preview API version exposing the crypto deposit fields
    apiVersion: '2026-03-04.preview',
    appInfo: {
      name: 'hitpay-mpp-samples',
      version: '0.0.1',
    },
  })

  const mppSecretKey = crypto.randomBytes(32).toString('base64')
  const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 })

  async function resolveDepositAddress(req: Request, price: Price): Promise<`0x${string}`> {
    const auth = req.headers.get('authorization')
    if (auth && Credential.extractPaymentScheme(auth)) {
      const cred = Credential.fromRequest(req)
      const recipient = cred.challenge.request.recipient as `0x${string}` | undefined
      if (!recipient) throw new Error('credential missing recipient')
      if (!cache.has(recipient)) throw new Error(`recipient ${recipient} not in cache`)
      return recipient
    }

    if (TEMPO_RECIPIENT) {
      console.log(`[stripe-mpp] static recipient ${TEMPO_RECIPIENT} ($${price.amount})`)
      cache.set(TEMPO_RECIPIENT, true)
      return TEMPO_RECIPIENT as `0x${string}`
    }

    const amountInCents = Math.round(Number(price.amount) * 100)
    const pi = await stripeClient.paymentIntents.create({
      amount: amountInCents,
      currency: price.currency,
      payment_method_types: ['crypto'],
      payment_method_data: { type: 'crypto' },
      payment_method_options: {
        crypto: {
          mode: 'deposit',
          deposit_options: { networks: ['tempo'] },
        } as Stripe.PaymentIntentCreateParams.PaymentMethodOptions.Crypto,
      },
      confirm: true,
    })

    if (!pi.next_action || !('crypto_display_details' in pi.next_action)) {
      throw new Error('PaymentIntent missing crypto_display_details')
    }
    const details = pi.next_action.crypto_display_details as unknown as {
      deposit_addresses?: Record<string, { address?: string }>
    }
    const addr = details.deposit_addresses?.tempo?.address
    if (!addr) throw new Error('PaymentIntent missing tempo deposit address')

    console.log(`[stripe-mpp] PI ${pi.id} → ${addr} ($${(amountInCents / 100).toFixed(2)})`)
    cache.set(addr, true)
    return addr as `0x${string}`
  }

  return {
    protect: (price, handler) => async (req) => {
      const recipient = await resolveDepositAddress(req, price)

      const mppx = Mppx.create({
        methods: [tempo.charge({ currency: TEMPO_USDC, recipient, testnet: true })],
        secretKey: mppSecretKey,
      })

      const response = await Mppx.compose(
        mppx.tempo.charge({ amount: price.amount, recipient }),
      )(req)

      if (response.status === 402) return response.challenge

      const result = await handler(req)
      return response.withReceipt(result)
    },
  }
}

function createStubMpp(): StripeMpp {
  return {
    protect: (price, handler) => async (req) => {
      const auth = req.headers.get('authorization') ?? ''
      if (auth.startsWith('Payment stub-')) {
        console.log(`[stripe-stub] credential accepted: ${auth.slice(0, 32)}…`)
        return handler(req)
      }
      const sessionId = `stub-${crypto.randomUUID()}`
      console.log(`[stripe-stub] issued 402 (${price.amount} ${price.currency}) → ${sessionId}`)
      return new Response(
        JSON.stringify({
          error: 'Payment Required',
          protocol: 'stripe-mpp',
          mode: 'stub',
          amount: price.amount,
          currency: price.currency,
          deposit_address: '0xSTUB000000000000000000000000000000000000',
          network: 'tempo-stub',
          session_id: sessionId,
          instructions: `Reply with "Authorization: Payment stub-${sessionId}" to settle.`,
        }),
        {
          status: 402,
          headers: {
            'content-type': 'application/json',
            'www-authenticate': `Payment realm="conduit", method="stripe-mpp-stub", amount="${price.amount}", currency="${price.currency}", session="${sessionId}"`,
          },
        },
      )
    },
  }
}
