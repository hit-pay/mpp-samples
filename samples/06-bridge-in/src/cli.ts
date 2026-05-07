// CLI runner for the bridge-in flow. Hits the local server's /bridge-in SSE
// endpoint and pretty-prints each event as it arrives.
//
// Usage:
//   pnpm cli <usd> <0xrecipient>
//
// e.g. pnpm cli 1 0xa38f2bebdaf8cda5397a067d74de6c808dc64060

import { config } from 'dotenv'

config()

const PORT = Number(process.env.PORT?.trim() || '4002')
const SERVER = `http://localhost:${PORT}`

const usd = process.argv[2] ?? '1'
const recipient = process.argv[3] ?? ''

if (!recipient) {
  console.error('usage: pnpm cli <usd> <0xrecipient>')
  console.error('example: pnpm cli 1 0xa38f2bebdaf8cda5397a067d74de6c808dc64060')
  process.exit(1)
}

function log(stage: string, msg: string) {
  console.log(`  ${stage.padEnd(12)} │ ${msg}`)
}

async function main() {
  const t0 = Date.now()
  const target = `${SERVER}/bridge-in?usd=${encodeURIComponent(usd)}&recipient=${encodeURIComponent(recipient)}`
  console.log(`\n━━━ BRIDGE-IN ━━━`)
  log('target', target)
  log('recipient', recipient)
  log('amount', `$${usd} USDC requested → SGD via PayNow`)
  console.log('')

  const res = await fetch(target)
  if (!res.ok) {
    console.error(`✗ ${res.status}: ${await res.text()}`)
    process.exit(1)
  }
  if (!res.body) {
    console.error('✗ no SSE body')
    process.exit(1)
  }
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
      const d = JSON.parse(m[2]!) as Record<string, unknown>
      if (evt === 'bridge-charge') {
        log('charge', `S$${d.amount_sgd} PayNow · ${String(d.charge_id)}`)
        log('PAY HERE', String(d.checkout_url))
        log('polling', String(d.polling_url))
        log('hint', 'Open the PAY HERE URL in a HitPay sandbox payer to approve.')
      } else if (evt === 'bridge-paid') {
        log('paid', `S$${d.fiat_received} settled · ${d.settled_in_ms}ms`)
      } else if (evt === 'bridge-tempo-tx') {
        log('tempo-tx', `${d.usdc} USDC → ${String(d.recipient).slice(0, 10)}… block ${d.block}`)
        log('tx', String(d.tx_hash))
        log('explorer', String(d.explorer))
      } else if (evt === 'bridge-done') {
        log('done', `S$${d.fiat_in_sgd} → ${d.usdc_out} USDC · ${d.total_ms}ms total`)
      } else if (evt === 'error') {
        log('error', JSON.stringify(d))
      }
    }
  }
  console.log(`\n  ⚡ total ${Date.now() - t0}ms\n`)
}

main().catch((e) => {
  console.error('cli error:', e instanceof Error ? e.message : e)
  process.exit(1)
})
