# 02 — COLLECT saved-method (silent repeat charges)

The HitPay MPP saved-method binding pattern. First hit returns a 402 with a setup URL; the buyer approves the wallet bind once; every subsequent hit charges silently with a JWS receipt. Same shape as Stripe's "off-session" charges but for SEA wallets — GrabPay, ShopeePay, Touch'n'Go.

## What this sample teaches

- **Two-stage flow.** Setup (`POST /v1/saved-payment-methods`) returns a `setup_checkout_url` and a `saved_method_id`. Charge (`POST /v1/charges` with `saved_method_id`) returns a JWS receipt directly — no buyer interaction.
- **Background poll for bind status.** While the buyer is approving the wallet in their phone, your server polls `GET /v1/saved-payment-methods/{id}` until it returns `bound`. Once bound, the saved-method-id is cached and reused.
- **Per-(currency, method) binding.** A buyer can have separate binds for `grabpay_direct/MYR` and `grabpay_direct/SGD` — they're independent in the broker.
- **`max_amount_per_charge` ceiling.** The bind carries a per-charge cap; this sample sets it to 10× the per-session price as a stolen-token safeguard.

## Prereqs

- Node 22+ and pnpm 9+.
- A HitPay sandbox account: sign up at [dashboard.sandbox.hit-pay.com](https://dashboard.sandbox.hit-pay.com).
- Your sandbox **API key** and **webhook salt** from *Developers → API Keys*.

## Setup

```bash
pnpm install
cp .env.template .env
# Fill in HITPAY_API_KEY and HITPAY_WEBHOOK_SALT
pnpm dev
```

## Run the demo

**1. First hit — returns a 402 with the bind setup URL:**

```bash
curl -i 'http://localhost:4001/tutor-saved?country=sg&method=grabpay_direct'
# 402 Payment Required
# www-authenticate: Payment method="hitpay", request="..."
# {"error":"payment_required","challenge":{"amount":"5.00","currency":"sgd","description":"AI tutor session (SG) — bind grabpay_direct","methodDetails":{"checkout_url":"https://securecheckout.sandbox.hit-pay.com/.../setup","expires_at":"...","polling_url":"..."}},"mode":"saved-method-setup","method":"grabpay_direct","country":"sg"}
```

**2. Open the `checkout_url`** in a HitPay sandbox payer and approve the GrabPay bind.

**3. Wait ~2s** — the server's background poll detects the bind and writes it to the in-process store. Watch the server logs for:

```
[ai-seller] saved method bound: SGD/grabpay_direct → smid_...
```

**4. Re-hit the same endpoint — silent charge:**

```bash
curl -i 'http://localhost:4001/tutor-saved?country=sg&method=grabpay_direct'
# 200 OK
# mpp-receipt: <JWS>
# {"result":"tutor session unlocked: lesson_id=lsn_demo","market":"sg","paid":{"amount":"5.00","currency":"sgd","method":"grabpay_direct","mode":"silent"},"settled_at":"..."}
```

Repeat as many times as you want — every hit charges instantly.

## Inspect / reset

```bash
# See what's bound
curl -s http://localhost:4001/saved-method
# {"bound":[{"paymentMethod":"grabpay_direct","currency":"sgd","savedMethodId":"smid_...","boundAt":"..."}]}

# Clear a specific bind
curl -X POST 'http://localhost:4001/saved-method/reset?method=grabpay_direct&currency=sgd'

# Clear all binds
curl -X POST 'http://localhost:4001/saved-method/reset'

# Demo helper: mark bound without polling (useful with a local broker stub)
curl -X POST http://localhost:4001/saved-method/bound \
  -H 'content-type: application/json' \
  -d '{"paymentMethod":"grabpay_direct","currency":"sgd","savedMethodId":"smid_test"}'
```

## Method × country matrix

| Country | grabpay_direct | shopee_pay | touch_n_go |
|---|---|---|---|
| SG | ✅ | ✅ | — |
| MY | ✅ | ✅ | ✅ |
| ID | ✅ | ✅ | — |
| PH | ✅ | ✅ | — |
| TH | ✅ | ✅ | — |

## Extending this sample

- **Persistence.** `saved-method-store.ts` is in-memory and dies on restart. For production, swap the `Map` for a Postgres table keyed by `{customer_id, currency, payment_method}`.
- **Per-customer binds.** This sample hardcodes `demo@hitpay.dev`. Real apps would key on the authenticated user.
- **Webhook bind notification.** Background polling works but is wasteful. The HitPay broker also fires webhook events on bind — see [`06-bridge-in`](../06-bridge-in) for the webhook receiver pattern; same applies here for `saved_method.bound`.

## Files

- `src/server.ts` — Hono server with `/tutor-saved` + `/saved-method/*` routes
- `src/lib/mpp-saved-method.ts` — wraps the three MPP broker endpoints (setup / poll / charge)
- `src/lib/saved-method-store.ts` — in-process `Map<currency:method, savedMethod>`

## License

MIT.
