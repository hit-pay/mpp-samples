/**
 * Pending-payout ledger for the deferred-sweep model.
 *
 * Per topup we append a row recording USDC charged + SGD owed to the provider.
 * /v1/transfers no longer fires per topup — it fires once per provider during
 * /sweep, against the cumulative unswept SGD on this ledger.
 *
 * Persistence is a JSON file under data/ so a server restart doesn't lose
 * the agent's prepaid credit obligations.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LEDGER_PATH = path.resolve(__dirname, '../../data/ledger.json')

export type LedgerSource = 'topup' | 'pay_per_call'

export interface LedgerEntry {
  id: string
  service: string
  calls: number
  usdc_charged: string
  sgd_owed: string
  created_at: number
  swept: boolean
  source?: LedgerSource // missing on legacy rows; treated as 'topup'
  transfer_id?: string
  swept_at?: number
}

interface Snapshot {
  entries: LedgerEntry[]
}

function load(): Snapshot {
  try {
    const raw = fs.readFileSync(LEDGER_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Snapshot
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] }
  } catch {
    return { entries: [] }
  }
}

function save(snap: Snapshot): void {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true })
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(snap, null, 2))
}

export function append(input: {
  service: string
  calls: number
  usdc_charged: string
  sgd_owed: string
  source?: LedgerSource
}): LedgerEntry {
  const snap = load()
  const entry: LedgerEntry = {
    id: `led_${crypto.randomBytes(8).toString('hex')}`,
    service: input.service,
    calls: input.calls,
    usdc_charged: input.usdc_charged,
    sgd_owed: input.sgd_owed,
    created_at: Date.now(),
    swept: false,
    source: input.source ?? 'topup',
  }
  snap.entries.push(entry)
  save(snap)
  return entry
}

export interface PendingBucket {
  service: string
  entry_count: number
  total_calls: number
  total_sgd: string
  total_usdc: string
  entry_ids: string[]
}

export function pendingByService(filter?: { source?: LedgerSource }): PendingBucket[] {
  const snap = load()
  const buckets = new Map<string, PendingBucket>()
  for (const e of snap.entries) {
    if (e.swept) continue
    if (filter?.source) {
      const entrySource = e.source ?? 'topup'
      if (entrySource !== filter.source) continue
    }
    const b = buckets.get(e.service) ?? {
      service: e.service,
      entry_count: 0,
      total_calls: 0,
      total_sgd: '0',
      total_usdc: '0',
      entry_ids: [],
    }
    b.entry_count += 1
    b.total_calls += e.calls
    b.total_sgd = (Number(b.total_sgd) + Number(e.sgd_owed)).toFixed(2)
    b.total_usdc = (Number(b.total_usdc) + Number(e.usdc_charged)).toFixed(2)
    b.entry_ids.push(e.id)
    buckets.set(e.service, b)
  }
  return [...buckets.values()].sort((a, b) => a.service.localeCompare(b.service))
}

export function markSwept(entryIds: string[], transferId: string): void {
  const snap = load()
  const idSet = new Set(entryIds)
  const sweptAt = Date.now()
  for (const e of snap.entries) {
    if (idSet.has(e.id) && !e.swept) {
      e.swept = true
      e.transfer_id = transferId
      e.swept_at = sweptAt
    }
  }
  save(snap)
}

export function listAll(): LedgerEntry[] {
  return load().entries
}
