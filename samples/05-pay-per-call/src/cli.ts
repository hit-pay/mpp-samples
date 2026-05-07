// CLI for the pay-per-call flow.
//
// Usage:
//   pnpm cli call translate "hello world"     — single pay-per-call hit
//   pnpm cli ledger                           — view ledger state
//   pnpm cli eod-sweep                        — mocked end-of-day SGD aggregation

import { Mppx, tempo } from 'mppx/client'
import { privateKeyToAccount } from 'viem/accounts'
import { config } from 'dotenv'

config()

const PORT = Number(process.env.PORT?.trim() || '4002')
const SERVER = `http://localhost:${PORT}`
const STRIPE_STUB = (process.env.STRIPE_STUB?.trim() || '1') === '1'
const TEMPO_PRIVATE_KEY = (process.env.TEMPO_PRIVATE_KEY?.trim() || '') as `0x${string}` | ''

type Mode = 'call' | 'ledger' | 'eod-sweep'
const MODE = ((['call', 'ledger', 'eod-sweep'] as Mode[]).includes(process.argv[2] as Mode)
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

async function runCall() {
  const service = process.argv[3] ?? 'translate'
  const text = process.argv.slice(4).join(' ') || 'hello world'
  const target = `${SERVER}/pay-per-call/${service}?text=${encodeURIComponent(text)}`
  console.log(`\n━━━ PAY-PER-CALL ━━━`)
  log('mode', `Stripe MPP ${STRIPE_STUB ? 'STUB' : 'REAL (Tempo testnet)'}`)
  log('target', target)
  console.log('')
  const res = await payOnce(target)
  if (!res.ok) {
    console.error(`✗ ${res.status}: ${await res.text()}`)
    process.exit(1)
  }
  const usdc = res.headers.get('x-usdc-charged') ?? '?'
  const sgd = res.headers.get('x-sgd-owed') ?? '?'
  const entry = res.headers.get('x-ledger-entry') ?? '?'
  const body = (await res.json()) as { output?: unknown; service?: string }
  log('charged', `$${usdc} USDC on Tempo · S$${sgd} accrued (deferred to /eod-sweep)`)
  log('ledger', `${entry.slice(0, 16)}… · ${body.service}`)
  log('result', JSON.stringify(body.output))
}

async function runEodSweep() {
  console.log(`\n━━━ EOD SWEEP (mocked) ━━━`)
  log('target', `${SERVER}/eod-sweep`)
  const res = await fetch(`${SERVER}/eod-sweep`)
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
  if (MODE === 'call') await runCall()
  else if (MODE === 'eod-sweep') await runEodSweep()
  else await runLedger()
  console.log(`\n  ⚡ total ${Date.now() - t0}ms\n`)
}

main().catch((e) => {
  console.error('cli error:', e instanceof Error ? e.message : e)
  process.exit(1)
})
