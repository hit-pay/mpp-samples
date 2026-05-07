# 05 — Pay-per-call (per-request USDC + mocked EOD aggregation)

The "metered" pattern. Every API call to the SG service is gated by an independent USDC settlement on Tempo — no pre-funding, no credit tokens. SGD owed accrues to a ledger; an `eod-sweep` pretends to issue one HitPay transfer per service at end-of-day (always mocked here — production would batch at your chosen cadence).

## What this sample teaches

- **One charge per call.** Compare to sample 04 (prepaid-credits): there, one USDC charge buys N calls. Here, every call settles independently. Right pattern when usage is unpredictable or high-variance.
- **Same Stripe MPP wrapper, different shape.** `stripe.protect(price, handler)` is a per-call decorator. The handler runs only on a paid request. The ledger row is appended inside the handler.
- **Source-tagged ledger.** Rows are tagged `source: 'pay_per_call'`. The eod-sweep filters on this so the ledger could happily host other flows (sample 04's `topup`) side-by-side without collision.
- **EOD is mock-only.** Production would replace `mockTransfer` with `liveTransfer` once payouts are gated on. The sample ships as mock so it's runnable without a HitPay payouts API key.

## Prereqs

- Node 22+ and pnpm 9+.
- (Real Stripe MPP only) Stripe API key + funded Tempo wallet. Skip if `STRIPE_STUB=1`.

## Setup

```bash
pnpm install
cp .env.template .env
pnpm dev
```

Two servers boot:

```
[SERVER] [pay-per-call] listening on http://localhost:4002
[SG]     [sg-receiver]  listening on http://localhost:4001
```

## Run the demo

```bash
# Make 3 paid calls
pnpm cli call translate "hello world"
pnpm cli call translate "another one"
pnpm cli call summarize "the cat sat on the mat the dog watched closely from afar"
```

Each one settles its USDC, forwards to the SG service, and appends a ledger row:

```
━━━ PAY-PER-CALL ━━━
  mode         │ Stripe MPP STUB
  target       │ http://localhost:4002/pay-per-call/translate?text=hello%20world

  402          │ 0.50 USD via stripe-mpp-stub
  paid         │ (stub: instant — no on-chain tx)
  charged      │ $0.50 USDC on Tempo · S$0.65 accrued (deferred to /eod-sweep)
  ledger       │ led_xxxxxxxxxxxxxxxx… · translate
  result       │ "HELLO WORLD lah"
```

```bash
# Inspect the unswept ledger
pnpm cli ledger
# pending     │ summarize  1 entries · 1 calls · S$0.54 unswept
# pending     │ translate  2 entries · 2 calls · S$1.30 unswept

# Aggregate and pay out (mocked) — one transfer per service
pnpm cli eod-sweep
# sweep        │ 2 providers · S$1.84 · mock-eod
# payout       │ → summarize S$0.54 (1 entries · 1 calls)
# ✓            │ summarize → tx_mock_xxxxxxxx (354ms mock)
# payout       │ → translate S$1.30 (2 entries · 2 calls)
# ✓            │ translate → tx_mock_xxxxxxxx (412ms mock)
# done         │ 2 providers settled · S$1.84
```

## When to pick pay-per-call vs prepaid-credits

| Pattern | Best for |
|---|---|
| **04 prepaid-credits** | Predictable, bursty usage. Buyer batches their topup; cheap and fast per-call. |
| **05 pay-per-call** (this sample) | Long-tail / unpredictable usage. No upfront commitment; small charges scale with actual use. |

Both share the same ledger and EOD-sweep machinery — easy to support both in one server (the original `conduit-mpp` does).

## Going live

1. **Real EOD payouts.** Swap `mockTransfer` for `liveTransfer` in `src/server.ts` (or thread `HITPAY_PAYOUT_MOCK` through). Add a real `HITPAY_PAYOUT_API_KEY`.
2. **Real Stripe MPP.** `STRIPE_STUB=0` + `STRIPE_SECRET_KEY` + `TEMPO_PRIVATE_KEY`.
3. **Cron the sweep.** Run `pnpm cli eod-sweep` from `cron`/Cloud Scheduler/etc. at your chosen cadence — once a day, once an hour, whatever your provider economics demand.

## Extending this sample

- **Variable per-call pricing.** Make `usdc_per_call` / `sgd_per_call` functions of the request (e.g. `text.length`).
- **Concurrent charges.** Right now charges are serialized per request (Hono handler). For a high-QPS endpoint, you may want to async-issue the Stripe charge and only block the handler on the credential validation.
- **Per-merchant settlement.** SERVICES is keyed by service id. For a multi-merchant marketplace, key by merchant + service and pay each merchant separately.

## Files

- `src/server.ts` — Hono server: `/pay-per-call/:service`, `/ledger`, `/eod-sweep`
- `src/sg-receiver.ts` — bundled SG upstream
- `src/cli.ts` — terminal client
- `src/lib/stripe-mpp.ts` — `stripe.protect(price, handler)` decorator
- `src/lib/hitpay-payouts.ts` — mock + live `/v1/transfers`
- `src/lib/ledger.ts` — JSON-backed pending-payout ledger (shared schema with sample 04)

## License

MIT.
