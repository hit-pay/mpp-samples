// Demo-grade in-memory store for HitPay MPP saved payment methods.
//
// Single hardcoded buyer (`demo@hitpay.dev`). The broker scopes a bind to a
// currency (max_amount_per_charge is currency-denominated), so the unique
// axis is `${currency}:${paymentMethod}` — a buyer can have separate binds
// for grabpay_direct/MYR and grabpay_direct/SGD. Lifetime is the seller
// process. No persistence.

export type SavedMethodId = string

export interface SavedMethod {
  paymentMethod: string
  currency: string
  savedMethodId: SavedMethodId
  boundAt: string
}

const store = new Map<string, SavedMethod>()
const key = (currency: string, paymentMethod: string) => `${currency.toLowerCase()}:${paymentMethod}`

export const DEMO_BUYER_EMAIL = 'demo@hitpay.dev'

export function get(currency: string, paymentMethod: string): SavedMethod | undefined {
  return store.get(key(currency, paymentMethod))
}

export function has(currency: string, paymentMethod: string): boolean {
  return store.has(key(currency, paymentMethod))
}

export function set(method: SavedMethod): void {
  store.set(key(method.currency, method.paymentMethod), method)
}

export function clear(filter?: { currency?: string; paymentMethod?: string }): void {
  if (!filter) {
    store.clear()
    return
  }
  if (filter.currency && filter.paymentMethod) {
    store.delete(key(filter.currency, filter.paymentMethod))
    return
  }
  for (const [k, v] of store.entries()) {
    if (filter.currency && v.currency !== filter.currency.toLowerCase()) continue
    if (filter.paymentMethod && v.paymentMethod !== filter.paymentMethod) continue
    store.delete(k)
  }
}

export function list(): SavedMethod[] {
  return Array.from(store.values())
}
