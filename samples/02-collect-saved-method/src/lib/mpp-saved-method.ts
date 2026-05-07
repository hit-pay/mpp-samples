// HitPay MPP — saved payment methods (embedded direct-link).
//
// Wraps two broker endpoints that the @hit-pay/mpp SDK does not expose yet:
//   POST /v1/saved-payment-methods                   — issue setup URL + pending id
//   GET  /v1/saved-payment-methods/{id}              — poll bind status
//   POST /v1/charges  (with saved_method_id)         — silent recurring charge
//
// Request shape mirrors MppServiceClient: every request carries `api_key`
// and `webhook_salt`. Charges also carry `nonce` and `request_hash` so the
// broker can replay-protect and JWS-sign.

import 'dotenv/config'
import { randomUUID } from 'node:crypto'

const HITPAY_API_KEY = process.env.HITPAY_API_KEY?.trim() || ''
const HITPAY_WEBHOOK_SALT = process.env.HITPAY_WEBHOOK_SALT?.trim() || ''
const HITPAY_MPP_ENDPOINT = process.env.HITPAY_MPP_ENDPOINT?.trim() || 'https://sandbox.mpp.hitpay.dev'

const nonce = () => randomUUID().replace(/-/g, '').slice(0, 16)

// Broker enum (per /v1/saved-payment-methods validation):
// grabpay_direct | shopee_pay | touch_n_go
export type SavedPaymentMethod = 'grabpay_direct' | 'shopee_pay' | 'touch_n_go'

export interface SetupResult {
  saved_method_id: string
  setup_checkout_url: string
  expires_at: string
  polling_url: string
}

export interface PollResult {
  status: 'pending' | 'bound' | 'failed' | 'expired'
  saved_method_id: string
}

export interface ChargeArgs {
  savedMethodId: string
  price: { amount: string; currency: string; description?: string }
  requestHash: string
}

export interface ChargeResult {
  challenge_id: string
  receipt_jws: string
  paid_at: string
}

function endpoint(path: string): string {
  return `${HITPAY_MPP_ENDPOINT}${path}`
}

export async function setupSavedMethod(args: {
  paymentMethod: SavedPaymentMethod
  customerEmail: string
  currency: string
  maxAmountPerCharge: string
  requestHash: string
}): Promise<SetupResult> {
  const res = await fetch(endpoint('/v1/saved-payment-methods'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: HITPAY_API_KEY,
      webhook_salt: HITPAY_WEBHOOK_SALT,
      payment_method: args.paymentMethod,
      customer_email: args.customerEmail,
      currency: args.currency,
      max_amount_per_charge: args.maxAmountPerCharge,
      request_hash: args.requestHash,
      nonce: nonce(),
    }),
  })
  if (!res.ok) throw new Error(`mpp-service setupSavedMethod failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as SetupResult
}

export async function pollSavedMethod(savedMethodId: string): Promise<PollResult> {
  const res = await fetch(endpoint(`/v1/saved-payment-methods/${encodeURIComponent(savedMethodId)}`), {
    method: 'GET',
    headers: { 'x-api-key': HITPAY_API_KEY },
  })
  if (!res.ok) throw new Error(`mpp-service pollSavedMethod failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as PollResult
}

export async function chargeSavedMethod(args: ChargeArgs): Promise<ChargeResult> {
  const res = await fetch(endpoint('/v1/charges'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      amount: args.price.amount,
      currency: args.price.currency,
      description: args.price.description,
      nonce: nonce(),
      request_hash: args.requestHash,
      api_key: HITPAY_API_KEY,
      webhook_salt: HITPAY_WEBHOOK_SALT,
      saved_method_id: args.savedMethodId,
    }),
  })
  if (!res.ok) throw new Error(`mpp-service chargeSavedMethod failed: ${res.status} ${await res.text()}`)
  const data = (await res.json()) as Partial<ChargeResult> & { checkout_url?: string }
  if (data.checkout_url) {
    throw new Error('mpp-service returned a checkout_url for a saved-method charge — the bind has not completed')
  }
  if (!data.receipt_jws || !data.challenge_id || !data.paid_at) {
    throw new Error(`mpp-service chargeSavedMethod returned an unexpected body: ${JSON.stringify(data)}`)
  }
  return data as ChargeResult
}
