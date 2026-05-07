// In-process registry that lets the webhook handler wake the in-flight
// /bridge-in SSE stream when HitPay reports a payment as completed.
//
// Keyed by the underlying HitPay payment-request `reference_number`, which
// the bridge-in route sets to the MPP `challengeId` (e.g. mpp_ch_xxxxx).
// HitPay echoes that field back on the webhook payload.

export type BridgeStatus = 'paid' | 'expired'

const waiters = new Map<string, (status: BridgeStatus) => void>()

export function register(referenceNumber: string): Promise<BridgeStatus> {
  return new Promise<BridgeStatus>((resolve) => {
    waiters.set(referenceNumber, resolve)
  })
}

export function notify(referenceNumber: string, status: BridgeStatus): boolean {
  const resolver = waiters.get(referenceNumber)
  if (!resolver) return false
  waiters.delete(referenceNumber)
  resolver(status)
  return true
}

export function cleanup(referenceNumber: string): void {
  waiters.delete(referenceNumber)
}

export function inFlight(): string[] {
  return Array.from(waiters.keys())
}
