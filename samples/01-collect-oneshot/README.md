# 01 — COLLECT one-shot (5 SEA rails)

The minimum viable HitPay MPP integration. A single HTTP route returns 402 with a real local-rail QR per buyer market — PayNow (SG), FPX (MY), QRIS (ID), GCash (PH), PromptPay (TH).

## What this sample teaches

- How to wrap any handler with `mpp.protect(price, handler)` so it returns a 402 challenge until the buyer pays.
- How to make `price` dynamic per-request (here: by `?country=` query param) so one endpoint serves five rails.
- What the 402 response looks like (`www-authenticate: Payment ...` header + JSON challenge body with `checkout_url`).
- What the 200 response looks like once paid (your handler runs; an `mpp-receipt` header carries the JWS receipt the buyer can verify).

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

You should see `[collect-oneshot] listening on http://localhost:4001`.

## Run the demo

```bash
# Get a PayNow QR for an SG buyer
curl -i http://localhost:4001/tutor?country=sg

# 402 Payment Required
# www-authenticate: Payment method="hitpay", request="..."
# {"error":"payment_required","challenge":{"amount":"5.00","currency":"sgd","description":"AI tutor session (SG · PayNow)","methodDetails":{"checkout_url":"https://securecheckout.sandbox.hit-pay.com/payment-request/@hitpay/<uuid>/checkout","expires_at":"...","polling_url":"..."}}}
```

Open the `checkout_url` in a browser, complete the sandbox PayNow flow, then re-curl the same endpoint — this time the MPP layer charges the buyer's saved session and your handler runs:

```bash
curl -i http://localhost:4001/tutor?country=sg
# 200 OK
# mpp-receipt: <JWS>
# {"result":"tutor session unlocked: lesson_id=lsn_demo","market":"sg","paid":{"amount":"5.00","currency":"sgd"},"settled_at":"..."}
```

Try the other rails:

```bash
curl -s http://localhost:4001/tutor?country=my   # RM 15.00 FPX
curl -s http://localhost:4001/tutor?country=id   # Rp 50,000 QRIS
curl -s http://localhost:4001/tutor?country=ph   # ₱200.00 GCash
curl -s http://localhost:4001/tutor?country=th   # ฿120.00 PromptPay
```

## Extending this sample

- **Add a new market**: add an entry to `PRICE_BY_COUNTRY` in `src/server.ts`. The MPP broker picks the right rail from the `currency` field.
- **Make pricing dynamic**: `pickPrice` is a function of the incoming `Request` — pull pricing from a database, a feature flag, or per-customer logic.
- **Multiple endpoints**: wrap as many handlers as you want with `mpp.protect(...)`. Each charge is an independent challenge.
- **Need silent repeat charges?** See [`02-collect-saved-method`](../02-collect-saved-method) for the saved-method pattern.

## Files

- `src/server.ts` — entire sample (~70 lines)
- `.env.template` — required env vars

## License

MIT.
