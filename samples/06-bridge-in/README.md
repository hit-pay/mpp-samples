# 06 — BRIDGE-IN (PayNow SGD → Tempo USDC)

Reverse cross-rail. A SEA buyer pays SGD via PayNow; a treasury wallet signs USDC on Tempo testnet to a recipient address. Settlement happens within ~1s of the buyer's payment when the webhook is wired up.

## What this sample teaches

- **Webhook-first detection.** Register `POST /webhooks/hitpay` as your webhook target in the HitPay dashboard, subscribed to `payment_request.completed`. The route verifies the HMAC signature and notifies the in-flight `/bridge-in` SSE stream.
- **Polling fallback.** If the webhook isn't wired up, a 5-min polling loop against `GET /v1/payment-requests/{id}` still detects the payment. Whichever path sees `paid` first wins (`Promise.race`).
- **An important gotcha:** the underlying PR's top-level `status` can lag in sandbox even after `payments[0].status === 'succeeded'`. The poller in `src/lib/hitpay-poll.ts` checks both — if you're rolling your own, do the same.
- **On-chain settlement.** Once `paid` fires, `sendUsdcOnTempo` writes a `transfer(recipient, amount)` to the USDC ERC-20 on Tempo Moderato testnet and waits for the receipt. Tx hash + block + explorer URL stream back to the client.

## Prereqs

- Node 22+ and pnpm 9+.
- A HitPay sandbox account: sign up at [dashboard.sandbox.hit-pay.com](https://dashboard.sandbox.hit-pay.com).
- Your sandbox **API key** and **webhook salt** from *Developers → API Keys*.
- A funded Tempo Moderato testnet wallet:
  - Generate a private key (e.g. `node -e "console.log('0x' + require('crypto').randomBytes(32).toString('hex'))"`).
  - Visit [faucet.moderato.tempo.xyz](https://faucet.moderato.tempo.xyz), fund it with both TEMPO (gas) and test USDC.
- A tunnel for HitPay's webhook to reach your local server:
  - `brew install cloudflared` (recommended, no signup), or
  - `brew install ngrok` (needs an account).

## Setup

```bash
pnpm install
cp .env.template .env
# Fill in HITPAY_API_KEY, HITPAY_WEBHOOK_SALT, HITPAY_TREASURY_PRIVATE_KEY
pnpm dev
```

You should see:
```
[bridge-in] listening on http://localhost:4002
[bridge-in] webhook receiver: POST http://localhost:4002/webhooks/hitpay
[bridge-in] FX 1 USD = 1.35 SGD · poll fallback 300000ms
```

## Wire up the webhook (recommended)

In a second terminal:

```bash
cloudflared tunnel --url http://localhost:4002
# Look for:  Your quick Tunnel has been created! Visit it at:
#            https://<random>.trycloudflare.com
```

In the [HitPay sandbox dashboard](https://dashboard.sandbox.hit-pay.com):
1. *Developers → Webhook Endpoints → Add Endpoint*.
2. **URL:** `https://<random>.trycloudflare.com/webhooks/hitpay`.
3. **Events:** check `payment_request.completed`.
4. Save.

(The webhook signing secret is the same `HITPAY_WEBHOOK_SALT` you put in your `.env`.)

## Run the demo

```bash
pnpm cli 1 0xa38f2bebdaf8cda5397a067d74de6c808dc64060
```

You'll see something like:

```
━━━ BRIDGE-IN ━━━
  target       │ http://localhost:4002/bridge-in?usd=1&recipient=0xa38f...4060
  recipient    │ 0xa38f2bebdaf8cda5397a067d74de6c808dc64060
  amount       │ $1 USDC requested → SGD via PayNow

  charge       │ S$1.35 PayNow · mpp_ch_...
  PAY HERE     │ https://securecheckout.sandbox.hit-pay.com/payment-request/@hitpay/<uuid>/checkout
  polling      │ https://sandbox.mpp.hitpay.dev/v1/charges/mpp_ch_...
  hint         │ Open the PAY HERE URL in a HitPay sandbox payer to approve.
```

Open the **PAY HERE** URL, complete the PayNow flow with a HitPay sandbox payer. Within ~1s of payment (webhook path) or up to ~2s (polling path):

```
  paid         │ S$1.35 settled · 18450ms
  tempo-tx     │ 1.00 USDC → 0xa38f2beb… block 16348918
  tx           │ 0x0e7ce085329eeab511ce7c6aafb593d03aec0c58913956724192cd7ed998c024
  explorer     │ https://explorer.moderato.tempo.xyz/tx/0x0e7ce085329eeab511ce7c6aafb593d03aec0c58913956724192cd7ed998c024
  done         │ S$1.35 → 1.00 USDC · 23210ms total
```

## Run without a tunnel (polling-only)

Skip the cloudflared step. The polling fallback still works — payment will be detected within 2s of the next poll cycle (max 5min). Slower than the webhook path, no HitPay dashboard configuration needed, won't work in production.

## How it actually works

```
buyer scan PayNow ───► HitPay sandbox ───► /webhooks/hitpay (HMAC-verified)
                                                    │
                                                    ▼
                                         bridgeWaiters.notify(challengeId)
                                                    │
                                                    ▼
                              Promise.race([webhookWaiter, pollFallback])
                                                    │
                                                    ▼
                                         sendUsdcOnTempo()  ←── treasury wallet signs
                                                    │
                                                    ▼
                                          USDC tx on Tempo testnet
```

Two parallel detection paths converge on the same in-process `Map<reference_number, resolver>`. The MPP broker sets the underlying PR's `reference_number` to the MPP `challengeId` (`mpp_ch_...`), so the webhook's `body.reference_number` and the bridge-in's awaited key are the same string.

## Files

- `src/server.ts` — Hono server, `/bridge-in` SSE route, `POST /webhooks/hitpay` route
- `src/cli.ts` — terminal client that consumes the SSE stream
- `src/lib/bridge-waiters.ts` — in-process registry coupling webhook → bridge-in
- `src/lib/hitpay-webhook.ts` — HMAC-SHA256 signature verifier
- `src/lib/hitpay-poll.ts` — polling fallback, with the top-level-vs-payments[] gotcha handled
- `src/lib/tempo-treasury.ts` — viem wallet that signs USDC transfers on Tempo

## Extending this sample

- **Multi-chain settlement.** `tempo-treasury.ts` is single-chain. To support more, add a chain registry and pick by `?chain=` query param.
- **Per-recipient FX policy.** Right now FX is a constant from `BRIDGE_FX_USD_TO_SGD`. Wire up a real quote feed (Wise / OFX / your treasury desk) and stream a `bridge-quote` SSE event before charging.
- **Persist in-flight state.** `bridge-waiters` is in-process and dies on restart. For production, persist `{reference_number, recipient, amount_usd, created_at}` to Postgres and have the webhook handler look up there instead.
- **Idempotency.** A buyer who scans the QR twice will fire two `payment_request.completed` events; right now the second one no-ops because the waiter has been deleted. For production, also write the Tempo tx to a settlement table keyed by `reference_number` and check before re-issuing.

## License

MIT.
