// HitPay /v1/transfers wrapper — live + mock implementations.
//
// Pick which to call based on HITPAY_PAYOUT_MOCK at boot. The shapes are
// identical so swapping is purely an env flip.

import 'dotenv/config'

const HITPAY_API_BASE = process.env.HITPAY_API_BASE?.trim() || 'https://api.sandbox.hit-pay.com'
const HITPAY_PAYOUT_API_KEY = process.env.HITPAY_PAYOUT_API_KEY?.trim() || ''

export interface Beneficiary {
  country: string
  transfer_method: string
  transfer_type: string
  currency: string
  holder_type: string
  holder_name: string
  bank_swift_code: string
  account_number: string
}

export interface TransferRequest {
  amount: string // decimal string e.g. "5.00"
  currency: 'sgd'
  beneficiary: Beneficiary
}

export interface TransferResult {
  id: string
  status: string
  payment_amount: number
  source_amount: number
  total_fee: number
  mocked: boolean
}

/**
 * Mock-mode HitPay transfer. Sandbox payouts are gated; if your account
 * doesn't have access yet, mock-mode lets you build against the call shape
 * and flip on a single env var when you do.
 */
export async function mockTransfer(req: TransferRequest): Promise<TransferResult> {
  const sleepMs = 200 + Math.floor(Math.random() * 300) // realistic 200–500ms latency
  await new Promise((r) => setTimeout(r, sleepMs))
  const id = `tx_mock_${Math.random().toString(36).slice(2, 14)}`
  console.log(
    `[payout-mock] transfer ${id} S$${req.amount} → ${req.beneficiary.holder_name} @ ${req.beneficiary.bank_swift_code} (${sleepMs}ms)`,
  )
  return {
    id,
    status: 'scheduled',
    payment_amount: Number(req.amount),
    source_amount: Number(req.amount),
    total_fee: 0.5,
    mocked: true,
  }
}

/**
 * Live HitPay transfer. Use only when HITPAY_PAYOUT_MOCK=0 AND
 * HITPAY_PAYOUT_API_KEY is a working key on a payouts-enabled account.
 */
export async function liveTransfer(req: TransferRequest): Promise<TransferResult> {
  if (!HITPAY_PAYOUT_API_KEY) throw new Error('HITPAY_PAYOUT_API_KEY required for live transfers')
  const url = `${HITPAY_API_BASE}/v1/transfers`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-BUSINESS-API-KEY': HITPAY_PAYOUT_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      source_currency: req.currency,
      payment_amount: Number(req.amount),
      beneficiary: req.beneficiary,
    }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HitPay /v1/transfers ${res.status}: ${text}`)
  const json = JSON.parse(text) as Omit<TransferResult, 'mocked'>
  return { ...json, mocked: false }
}
