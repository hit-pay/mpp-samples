// In-process credit-token store. A `cred_xxx` token is issued at topup time
// and decremented per drawdown call.

import crypto from 'node:crypto'

export interface Credit {
  service: string
  remaining: number
  topup_id: string
  created_at: number
}

const credits = new Map<string, Credit>()

export function issue(service: string, calls: number, topupId: string): { token: string; credit: Credit } {
  const token = `cred_${crypto.randomBytes(16).toString('hex')}`
  const credit: Credit = { service, remaining: calls, topup_id: topupId, created_at: Date.now() }
  credits.set(token, credit)
  return { token, credit }
}

export function consume(token: string, service: string): { ok: true; remaining: number } | { ok: false; reason: string } {
  const credit = credits.get(token)
  if (!credit) return { ok: false, reason: 'unknown_token' }
  if (credit.service !== service) return { ok: false, reason: 'service_mismatch' }
  if (credit.remaining <= 0) return { ok: false, reason: 'exhausted' }
  credit.remaining -= 1
  return { ok: true, remaining: credit.remaining }
}

export function inspect(token: string): Credit | undefined {
  return credits.get(token)
}
