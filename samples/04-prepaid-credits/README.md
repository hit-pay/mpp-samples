# 04 — Prepaid credits + sweep

The "topup" pattern. A buyer pays USDC up-front for N calls of an SG service. SGD owed accrues to a per-service ledger; one HitPay `/v1/transfers` per service fires later via `/sweep`. Decouples USDC settlement from SGD payout — useful when payout fees are high enough that batching matters.

## What this sample teaches

- **Topup vs drawdown.** `GET /topup/:service?calls=N` charges USDC and issues a `cred_xxx` credit token. Subsequent `GET /proxy/:service` calls present that token via `Authorization: Bearer cred_...` and decrement on each use.
- **Deferred sweep.** Per topup we append a row to a JSON-backed ledger (`data/ledger.json`); we don't fire a transfer. Eventually `GET /sweep` aggregates per-service unswept rows and issues one HitPay transfer per provider.
- **Source tagging.** Ledger rows carry `source: 'topup'`. Sample 05 (pay-per-call) uses the same ledger schema with `source: 'pay_per_call'`. `/sweep` filters on source so the two flows don't entangle.
- **Bundled SG receiver.** A second tiny Hono server (`src/sg-receiver.ts`, port 4001) provides the three upstream services (`/api/v1/{translate,summarize,sentiment}`). `pnpm dev` boots both via `concurrently`.

## Prereqs

- Node 22+ and pnpm 9+.
- A HitPay sandbox account (for live transfers) — sign up at [dashboard.sandbox.hit-pay.com](https://dashboard.sandbox.hit-pay.com). Mock mode works without this.
- (Real Stripe MPP only) Stripe API key + funded Tempo wallet. Skip if `STRIPE_STUB=1`.

## Setup

```bash
pnpm install
cp .env.template .env
# Defaults work — leave HITPAY_PAYOUT_MOCK=1 and STRIPE_STUB=1 for a no-credentials demo
pnpm dev
```

You should see two servers boot:

```
[SERVER] [prepaid-credits] listening on http://localhost:4002
[SG]     [sg-receiver]     listening on http://localhost:4001
```

## Run the demo

```bash
# 1. Topup 5 prepaid translate calls and immediately use them all
pnpm cli topup translate 5
```

Expected output:

```
━━━ TOPUP ━━━
  mode         │ Stripe MPP STUB
  target       │ http://localhost:4002/topup/translate?calls=5

  402          │ 2.50 USD via stripe-mpp-stub
  paid         │ (stub: instant — no on-chain tx)
  charged      │ $2.50 USDC for 5 calls @ translate
  fx           │ $2.50 → S$3.25 @ 1.35
  ledger       │ +S$3.25 owed to translate · led_...
  credit       │ 5 calls @ translate · cred_...

  call 1/5     │ "DEMO CALL 1 lah" · 4 left
  call 2/5     │ "DEMO CALL 2 lah" · 3 left
  ...
  call 5/5     │ "DEMO CALL 5 lah" · 0 left
```

```bash
# 2. Topup another service so /sweep has 2 providers to settle
pnpm cli topup summarize 3

# 3. Inspect the ledger
pnpm cli ledger
# pending     │ translate    2 entries · 8 calls · S$5.20 unswept
# pending     │ summarize    1 entries · 3 calls · S$1.62 unswept

# 4. Sweep — one HitPay /v1/transfers per service
pnpm cli sweep
# sweep        │ 2 providers · S$6.82 · mock
# payout       │ → summarize S$1.62 (1 entries · 3 calls)
# ✓            │ summarize → tx_mock_xxx (412ms mock)
# payout       │ → translate S$5.20 (2 entries · 8 calls)
# ✓            │ translate → tx_mock_xxx (354ms mock)
# done         │ 2 providers settled · S$6.82
```

## Why this pattern

- **Fewer payout fees.** One transfer per service per sweep window beats one transfer per topup.
- **Better cash management.** The agent's USDC settles immediately; you control when fiat actually leaves your account.
- **Same handler shape as one-shot.** `stripe.protect(price, handler)` works the same way — just wraps a different SSE-emitting handler.

## Going live

1. **Live HitPay payouts.** `HITPAY_PAYOUT_MOCK=0` + a real `HITPAY_PAYOUT_API_KEY`.
2. **Real Stripe MPP.** `STRIPE_STUB=0` + `STRIPE_SECRET_KEY` + `TEMPO_PRIVATE_KEY`.
3. **Replace the in-process credit store.** `src/lib/credits.ts` uses a `Map`; for production wire it to Postgres + Redis (or pick your ORM of choice).

## Extending this sample

- **Per-call upcharge.** Currently `usdc_per_call` and `sgd_per_call` are static in `SERVICES`. Make them functions of the request to support tiered pricing.
- **Sweep schedule.** Run `pnpm cli sweep` from cron, or add an internal `setInterval` boot in `src/server.ts` that runs `/sweep` every N minutes.
- **Refund / cancellation.** A topup that's never fully drawn down should refund unused USDC. Add `/topup/:topup_id/cancel` that issues a Tempo USDC transfer back to the buyer.

## Files

- `src/server.ts` — Hono server: `/topup`, `/proxy`, `/ledger`, `/sweep`
- `src/sg-receiver.ts` — bundled SG upstream (translate / summarize / sentiment)
- `src/cli.ts` — terminal client
- `src/lib/stripe-mpp.ts` — `stripe.protect(price, handler)` decorator
- `src/lib/hitpay-payouts.ts` — mock + live `/v1/transfers`
- `src/lib/credits.ts` — credit-token store
- `src/lib/ledger.ts` — JSON-backed pending-payout ledger

## License

MIT.
