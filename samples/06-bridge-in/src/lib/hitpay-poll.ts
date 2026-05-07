// Polling fallback for /bridge-in. The MPP broker creates the underlying
// HitPay payment-request and Conduit polls it directly, because the broker
// itself doesn't propagate state changes to its own /v1/charges/{id} record.
//
// This implementation reads BOTH the top-level `status` field AND the
// `payments[]` array. In sandbox runs we observed cases where a single
// successful PayNow `payments[0].status === 'succeeded'` lands on a PR
// whose top-level status is still `pending` — checking only top-level would
// time out spuriously. The webhook path is preferred (see hitpay-webhook.ts);
// this poller is a belt-and-suspenders fallback for dev environments where
// the tunnel/dashboard webhook is not configured.

const POLL_INTERVAL_MS = 2000

export type PollStatus = 'paid' | 'expired' | 'timeout' | 'not_found'

export function extractPaymentRequestId(checkoutUrl: string): string | null {
  const m = checkoutUrl.match(/payment-request\/@hitpay\/([a-f0-9-]{36})/i)
  return m ? m[1]! : null
}

interface PaymentEntry {
  status?: string
}

export async function pollPaymentRequestUntilPaid(
  checkoutUrl: string,
  apiBase: string,
  apiKey: string,
  deadlineAtMs: number,
): Promise<{ status: PollStatus; body?: Record<string, unknown> }> {
  const prId = extractPaymentRequestId(checkoutUrl)
  if (!prId) return { status: 'not_found' }
  const url = `${apiBase}/v1/payment-requests/${prId}`
  while (Date.now() < deadlineAtMs) {
    try {
      const res = await fetch(url, { headers: { 'X-BUSINESS-API-KEY': apiKey } })
      if (res.ok) {
        const body = (await res.json()) as Record<string, unknown> & { payments?: PaymentEntry[] }
        const top = String(body.status ?? '').toLowerCase()
        if (top === 'completed' || top === 'paid' || top === 'succeeded') {
          return { status: 'paid', body }
        }
        if (Array.isArray(body.payments) && body.payments.some((p) => String(p.status ?? '').toLowerCase() === 'succeeded')) {
          // Top-level can lag in sandbox; treat any succeeded payment as paid.
          return { status: 'paid', body }
        }
        if (top === 'expired' || top === 'cancelled' || top === 'failed') {
          return { status: 'expired', body }
        }
      }
    } catch {
      // transient network error — keep polling.
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return { status: 'timeout' }
}
