// CLI runner for the payroll batch flow. Hits the local /payroll SSE endpoint
// (with a Stripe MPP credential — real or stub) and pretty-prints each event.

import { Mppx, tempo } from 'mppx/client'
import { privateKeyToAccount } from 'viem/accounts'
import { config } from 'dotenv'

config()

const PORT = Number(process.env.PORT?.trim() || '4002')
const SERVER = `http://localhost:${PORT}`
const STRIPE_STUB = (process.env.STRIPE_STUB?.trim() || '1') === '1'
const TEMPO_PRIVATE_KEY = (process.env.TEMPO_PRIVATE_KEY?.trim() || '') as `0x${string}` | ''

function log(stage: string, msg: string) {
  console.log(`  ${stage.padEnd(12)} │ ${msg}`)
}

async function payViaMppx(target: string): Promise<Response> {
  if (!TEMPO_PRIVATE_KEY) {
    throw new Error('TEMPO_PRIVATE_KEY missing — fund a Tempo wallet and add to .env')
  }
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

async function consumePayrollSse(res: Response) {
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
      const data = JSON.parse(m[2]!)
      if (evt === 'fx-quote') log('fx', `$${data.usdc_in} USDC @ ${data.rate} = S$${data.sgd_out} SGD`)
      else if (evt === 'transfer-start') log('pay-provider', `→ ${data.name} S$${data.amount}`)
      else if (evt === 'transfer-done')
        log('✓', `${data.name} → ${data.transfer_id.slice(0, 16)}… (${data.took_ms}ms${data.mocked ? ' mock' : ' live'})`)
      else if (evt === 'transfer-failed') log('✗', `${data.name}: ${data.error}`)
      else if (evt === 'batch-done')
        log('done', `${data.count} providers paid · $${data.total_usdc} USDC → S$${data.total_sgd} SGD`)
      else if (evt === 'error') log('error', JSON.stringify(data))
    }
  }
}

async function main() {
  const t0 = Date.now()
  const target = `${SERVER}/payroll`
  console.log(`\n━━━ DISBURSE — PAYROLL ━━━`)
  log('mode', `Stripe MPP ${STRIPE_STUB ? 'STUB' : 'REAL (Tempo testnet)'}`)
  log('target', target)
  console.log('')

  const res = await payOnce(target)
  if (!res.ok) {
    console.error(`✗ ${res.status}: ${await res.text()}`)
    process.exit(1)
  }
  await consumePayrollSse(res)
  console.log(`\n  ⚡ total ${Date.now() - t0}ms\n`)
}

main().catch((e) => {
  console.error('cli error:', e instanceof Error ? e.message : e)
  process.exit(1)
})
