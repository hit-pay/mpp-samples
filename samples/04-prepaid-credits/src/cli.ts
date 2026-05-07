// CLI for the prepaid-credits flow.
//
// Usage:
//   pnpm cli topup translate 5         — topup 5 calls
//   pnpm cli ledger                    — view ledger state
//   pnpm cli sweep                     — settle all unswept ledger entries

import { Mppx, tempo } from 'mppx/client'
import { privateKeyToAccount } from 'viem/accounts'
import { config } from 'dotenv'

config()

const PORT = Number(process.env.PORT?.trim() || '4002')
const SERVER = `http://localhost:${PORT}`
const STRIPE_STUB = (process.env.STRIPE_STUB?.trim() || '1') === '1'
const TEMPO_PRIVATE_KEY = (process.env.TEMPO_PRIVATE_KEY?.trim() || '') as `0x${string}` | ''

type Mode = 'topup' | 'ledger' | 'sweep'
const MODE = ((['topup', 'ledger', 'sweep'] as Mode[]).includes(process.argv[2] as Mode)
  ? (process.argv[2] as Mode)
  : 'ledger')

function log(stage: string, msg: string) {
  console.log(`  ${stage.padEnd(12)} │ ${msg}`)
}

async function payViaMppx(target: string): Promise<Response> {
  if (!TEMPO_PRIVATE_KEY) throw new Error('TEMPO_PRIVATE_KEY missing')
  const account = privateKeyToAccount(TEMPO_PRIVATE_KEY)
  const mppx = Mppx.create({ methods: [tempo({ account })] })
  return mppx.fetch(target)
}

async function payViaStub(target: string): Promise<Response> {
  const challenge = await fetch(target)
  if (challenge.status !== 402) throw new Error(`expected 402, got ${challenge.status}`)
  const body = (await challenge.json()) as { session_id: string; amount: string; currency: string }
  log('402', `${body.amount} ${body.currency.toUpperCase()} via stripe-mpp-stub`)
  log('paid', `(stub: instant — no on-chain tx)`)
  return fetch(target, { headers: { authorization: `Payment stub-${body.session_id}` } })
}

async function payOnce(target: string): Promise<Response> {
  return STRIPE_STUB ? await payViaStub(target) : await payViaMppx(target)
}

interface TopupResult {
  service: string
  calls: number
  credit_token: string
  usdc_charged: string
  sgd_owed: string
}

async function consumeTopupSse(res: Response): Promise<TopupResult> {
  if (!res.body) throw new Error('no SSE body')
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buffer = ''
  const out: Partial<TopupResult> = {}
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += dec.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      const m = block.match(/^event: (\S+)\ndata: (.+)$/m)
      if (!m) continue
      const evt = m[1]!
      const data = JSON.parse(m[2]!) as Record<string, unknown>
      if (evt === 'stripe-verified') {
        out.service = String(data.service)
        out.calls = Number(data.calls)
        out.usdc_charged = String(data.amount_usdc)
        log('charged', `$${data.amount_usdc} USDC for ${data.calls} calls @ ${data.service}`)
      } else if (evt === 'fx-quote') {
        out.sgd_owed = String(data.sgd_out)
        log('fx', `$${data.usdc_in} → S$${data.sgd_out} @ ${data.rate}`)
      } else if (evt === 'ledger-appended') {
        log('ledger', `+S$${data.sgd_owed} owed to ${data.service} · ${String(data.entry_id).slice(0, 16)}…`)
      } else if (evt === 'credit-issued') {
        out.credit_token = String(data.credit_token)
        log('credit', `${data.calls_remaining} calls @ ${data.service} · ${String(data.credit_token).slice(0, 16)}…`)
      } else if (evt === 'error') {
        log('error', JSON.stringify(data))
      }
    }
  }
  if (!out.credit_token) throw new Error('topup did not return a credit token')
  return out as TopupResult
}

async function consumeSweepSse(res: Response) {
  if (!res.body) throw new Error('no SSE body')
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += dec.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      const m = block.match(/^event: (\S+)\ndata: (.+)$/m)
      if (!m) continue
      const evt = m[1]!
      const data = JSON.parse(m[2]!) as Record<string, unknown>
      if (evt === 'sweep-start') log('sweep', `${data.providers} providers · S$${data.total_sgd} · ${data.mode}`)
      else if (evt === 'sweep-empty') log('empty', String(data.message))
      else if (evt === 'transfer-start')
        log('payout', `→ ${data.service} S$${data.amount_sgd} (${data.entries} entries · ${data.calls} calls)`)
      else if (evt === 'transfer-done')
        log(
          '✓',
          `${data.service} → ${String(data.transfer_id).slice(0, 16)}… (${data.took_ms}ms${data.mocked ? ' mock' : ' live'})`,
        )
      else if (evt === 'transfer-failed') log('✗', `${data.service}: ${data.error}`)
      else if (evt === 'sweep-done') log('done', `${data.count} providers settled · S$${data.total_sgd}`)
      else if (evt === 'error') log('error', JSON.stringify(data))
    }
  }
}

async function drawDown(token: string, service: string, calls: number) {
  for (let i = 1; i <= calls; i++) {
    const text = `demo call ${i}`
    const res = await fetch(`${SERVER}/proxy/${service}/?text=${encodeURIComponent(text)}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      log('✗', `call ${i}/${calls}: ${res.status} ${await res.text()}`)
      return
    }
    const body = (await res.json()) as { output?: unknown }
    const remaining = res.headers.get('x-credit-remaining') ?? '?'
    log(`call ${i}/${calls}`, `${JSON.stringify(body.output)} · ${remaining} left`)
  }
}

async function runTopup() {
  const service = process.argv[3] ?? 'translate'
  const calls = Number.parseInt(process.argv[4] ?? '5', 10)
  const target = `${SERVER}/topup/${service}?calls=${calls}`
  console.log(`\n━━━ TOPUP ━━━`)
  log('mode', `Stripe MPP ${STRIPE_STUB ? 'STUB' : 'REAL (Tempo testnet)'}`)
  log('target', target)
  console.log('')

  const res = await payOnce(target)
  if (!res.ok) {
    console.error(`✗ ${res.status}: ${await res.text()}`)
    process.exit(1)
  }
  const t = await consumeTopupSse(res)
  console.log('')
  await drawDown(t.credit_token, service, calls)
}

async function runSweep() {
  console.log(`\n━━━ SWEEP ━━━`)
  log('target', `${SERVER}/sweep`)
  const res = await fetch(`${SERVER}/sweep`)
  if (!res.ok) {
    console.error(`✗ ${res.status}: ${await res.text()}`)
    process.exit(1)
  }
  await consumeSweepSse(res)
}

async function runLedger() {
  console.log(`\n━━━ LEDGER ━━━`)
  const res = await fetch(`${SERVER}/ledger`)
  const body = (await res.json()) as {
    pending_by_service: Array<{ service: string; total_sgd: string; entry_count: number; total_calls: number }>
    entries: Array<{ id: string; service: string; calls: number; sgd_owed: string; swept: boolean }>
  }
  const pending = body.pending_by_service
  if (pending.length === 0) log('pending', '(none — ledger is fully swept)')
  else {
    for (const p of pending) {
      log(p.service, `${p.entry_count} entries · ${p.total_calls} calls · S$${p.total_sgd} unswept`)
    }
  }
  log('entries', `${body.entries.length} total (${body.entries.filter((e) => e.swept).length} swept)`)
}

async function main() {
  const t0 = Date.now()
  if (MODE === 'topup') await runTopup()
  else if (MODE === 'sweep') await runSweep()
  else await runLedger()
  console.log(`\n  ⚡ total ${Date.now() - t0}ms\n`)
}

main().catch((e) => {
  console.error('cli error:', e instanceof Error ? e.message : e)
  process.exit(1)
})
