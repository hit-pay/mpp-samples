# HitPay MPP Samples

Self-contained reference implementations for every HitPay MPP use case. Each sample is a standalone TypeScript project that you can clone, install, and run on its own.

> **What is HitPay MPP?** Machine-payable protocol — agents and services exchange a 402 challenge for real local-rail payments (PayNow, FPX, QRIS, GCash, PromptPay), with verifiable JWS receipts on settlement. Pair it with Stripe MPP / Tempo for cross-border USDC settlement.

## Samples

| # | Sample | Pattern | Rails | Needs |
|---|---|---|---|---|
| 01 | [collect-oneshot](./samples/01-collect-oneshot) | One-shot 402 → local QR | PayNow · FPX · QRIS · GCash · PromptPay | HitPay sandbox |
| 02 | [collect-saved-method](./samples/02-collect-saved-method) | Saved-method binding + silent repeat charge | GrabPay · ShopeePay · Touch'n'Go | HitPay sandbox |
| 03 | [disburse-payroll](./samples/03-disburse-payroll) | USDC → batch HitPay /v1/transfers | Tempo USDC → SGD FAST | HitPay sandbox + Stripe + Tempo wallet |
| 04 | [prepaid-credits](./samples/04-prepaid-credits) | Pay USDC up-front for N calls; sweep SGD later | Tempo USDC → SGD FAST | HitPay sandbox + Stripe + Tempo wallet |
| 05 | [pay-per-call](./samples/05-pay-per-call) | One USDC charge per API call; mocked EOD SGD aggregation | Tempo USDC → SGD (mock) | HitPay sandbox + Stripe + Tempo wallet |
| 06 | [bridge-in](./samples/06-bridge-in) | SGD PayNow in → USDC on Tempo out (webhook-first) | PayNow SGD → Tempo USDC | HitPay sandbox + Tempo wallet + tunnel |

## Prerequisites

- **Node.js 22+** and **pnpm 9+**
- **HitPay sandbox account** — sign up at [dashboard.sandbox.hit-pay.com](https://dashboard.sandbox.hit-pay.com). Every sample needs `HITPAY_API_KEY` and `HITPAY_WEBHOOK_SALT` from *Developers → API Keys*.
- **(Samples 03–06) Tempo Moderato testnet wallet** — fund via the [Moderato faucet](https://faucet.moderato.tempo.xyz) with TEMPO (gas) and test USDC.
- **(Samples 03–05) Stripe MPP access** — optional. All three samples ship with `STRIPE_STUB=1` so you can run them without Stripe access.
- **(Sample 06) Tunnel** — `brew install cloudflared` (or `brew install ngrok`) so HitPay's webhook can reach your local server.

## Quick start

```bash
# Clone and install everything
git clone https://github.com/hit-pay/mpp-samples.git
cd mpp-samples
pnpm install

# Pick any sample
cd samples/01-collect-oneshot
cp .env.template .env  # fill in your HitPay sandbox keys
pnpm dev
```

Each sample's README has its own `.env.template` reference, run instructions, and curl/CLI examples.

## Repo layout

```
hitpay-mpp-samples/
├── README.md                  ← you are here
├── pnpm-workspace.yaml
├── package.json               ← root scripts (typecheck-all)
├── tsconfig.base.json         ← extended by every sample
└── samples/
    ├── 01-collect-oneshot/
    ├── 02-collect-saved-method/
    ├── 03-disburse-payroll/
    ├── 04-prepaid-credits/
    ├── 05-pay-per-call/
    └── 06-bridge-in/
```

Each sample is a fully self-contained pnpm workspace package — no cross-sample imports, no shared lib. Copying `samples/<name>/` out of this repo gives you a working starter project.

## Workspace scripts

```bash
pnpm typecheck   # tsc --noEmit across every sample
pnpm clean       # nuke node_modules + dist + data in every sample
```

## License

MIT.
