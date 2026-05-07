# 03 — DISBURSE payroll (USDC → batch SGD via FAST)

Cross-rail. A western treasury agent holds USDC on Tempo. One Stripe MPP charge accepts $X USDC, FX-converts to SGD, and fans out N HitPay `/v1/transfers` to SG bank accounts via FAST/PayNow — typically ~1s per transfer in sandbox.

## What this sample teaches

- **Two-MPP composition.** The server is gated by Stripe MPP (`stripe.protect`). Once paid in USDC, the handler runs and issues N HitPay `/v1/transfers`. Two protocols, one HTTP transaction.
- **Mock-mode payouts.** HitPay sandbox payouts are gated; flip `HITPAY_PAYOUT_MOCK=1` to simulate the call shape until your account is enabled. Same return type — your downstream code doesn't change.
- **Fan-out shape.** SSE stream emits `stripe-verified` → `fx-quote` → `batch-start` → `transfer-start`/`transfer-done` (× N) → `batch-done`. UIs and CLIs can render progress bar / timing per recipient.
- **Stripe MPP stub.** `STRIPE_STUB=1` (default) bypasses Stripe entirely so you can prototype the cross-rail composition without Stripe / Tempo access.

## Prereqs

- Node 22+ and pnpm 9+.
- A HitPay sandbox account (for live transfers) — sign up at [dashboard.sandbox.hit-pay.com](https://dashboard.sandbox.hit-pay.com), grab the **Payouts API key** from *Developers → API Keys*. Mock mode works without this.
- (Real Stripe MPP only) Stripe API key and a funded Tempo Moderato testnet wallet — fund at [faucet.moderato.tempo.xyz](https://faucet.moderato.tempo.xyz). Skip if `STRIPE_STUB=1`.

## Setup

```bash
pnpm install
cp .env.template .env
# At minimum, leave HITPAY_PAYOUT_MOCK=1 and STRIPE_STUB=1 for a no-credentials demo
pnpm dev
```

## Run the demo

```bash
pnpm cli
```

Output:

```
━━━ DISBURSE — PAYROLL ━━━
  mode         │ Stripe MPP STUB
  target       │ http://localhost:4002/payroll

  402          │ 200.00 USD via stripe-mpp-stub
  paid         │ (stub: instant — no on-chain tx)
  fx           │ $200.00 USDC @ 1.35 = S$270.00 SGD
  pay-provider │ → TranslateSG (translation API) S$67.50
  ✓            │ TranslateSG (translation API) → tx_mock_xxxxxxxxx (321ms mock)
  pay-provider │ → ACRALookup (KYB / company data) S$135.00
  ✓            │ ACRALookup (KYB / company data) → tx_mock_xxxxxxxxx (412ms mock)
  pay-provider │ → PostalSG (address validation) S$67.50
  ✓            │ PostalSG (address validation) → tx_mock_xxxxxxxxx (287ms mock)
  done         │ 3 providers paid · $200.00 USDC → S$270.00 SGD

  ⚡ total 1284ms
```

## Going live

1. **Live HitPay payouts.** Set `HITPAY_PAYOUT_MOCK=0` and put your sandbox payouts API key in `HITPAY_PAYOUT_API_KEY`. The SDK call shape is identical; transfers actually settle to the bank account configured.
2. **Real Stripe MPP.** Set `STRIPE_STUB=0`, add `STRIPE_SECRET_KEY` and a `TEMPO_PRIVATE_KEY` for a funded Tempo wallet. The CLI will sign a real USDC-on-Tempo transaction via `mppx`.

## How the recipient list works

Edit the `PROVIDERS` array in `src/server.ts`:

```ts
const PROVIDERS: ApiProvider[] = [
  { name: 'TranslateSG (translation API)', paynow: '+65 9123 4567', amount_sgd: '67.50' },
  // add yours
]
```

The bank account details (`SG_AGENT_BANK_HOLDER`, `SG_AGENT_BANK_SWIFT`, `SG_AGENT_BANK_ACCOUNT`) currently apply to every recipient. For a production payroll, extend `ApiProvider` with per-recipient bank details and remove the env defaults.

## Extending this sample

- **Other rails.** `Beneficiary.transfer_method` is currently `bank_transfer`. HitPay supports more (PayNow proxy, e-wallets in some markets) — see [HitPay Transfers docs](https://docs.hitpayapp.com).
- **Non-SGD payouts.** This sample is SGD-only. Add `currency: 'myr' | 'idr' | 'php' | 'thb'` and per-currency `Beneficiary` shapes.
- **Idempotency keys.** For real money, pass `Idempotency-Key` on the HitPay request and persist it locally so retries don't double-pay.

## Files

- `src/server.ts` — Hono server, `/payroll` SSE route
- `src/cli.ts` — terminal client (Stripe MPP stub or real)
- `src/lib/stripe-mpp.ts` — `stripe.protect(price, handler)` decorator
- `src/lib/hitpay-payouts.ts` — `mockTransfer` + `liveTransfer`

## License

MIT.
