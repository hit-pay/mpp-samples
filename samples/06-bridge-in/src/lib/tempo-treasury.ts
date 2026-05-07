// HitPay treasury wallet — signs outbound USDC transfers on Tempo testnet
// in response to fiat charges that resolve to paid via /bridge-in.
//
// In production this is a HitPay-controlled wallet keyed off a charge's
// metadata; in the demo a single private key (HITPAY_TREASURY_PRIVATE_KEY,
// or TEMPO_PRIVATE_KEY as fallback) plays the role.

import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const TEMPO_TESTNET_RPC = 'https://rpc.moderato.tempo.xyz'
const USDC = '0x20c0000000000000000000000000000000000000' as const
const USDC_DECIMALS = 6

const erc20 = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
])

let cachedChain: ReturnType<typeof defineChain> | undefined

async function resolveChain() {
  if (cachedChain) return cachedChain
  const reader = createPublicClient({ transport: http(TEMPO_TESTNET_RPC) })
  const id = await reader.getChainId()
  cachedChain = defineChain({
    id,
    name: 'Tempo Moderato',
    nativeCurrency: { name: 'TEMPO', symbol: 'TEMPO', decimals: 18 },
    rpcUrls: { default: { http: [TEMPO_TESTNET_RPC] } },
  })
  return cachedChain
}

function resolveTreasuryKey(): `0x${string}` {
  const treasury = process.env.HITPAY_TREASURY_PRIVATE_KEY?.trim() as `0x${string}` | undefined
  if (treasury) return treasury
  const tempo = process.env.TEMPO_PRIVATE_KEY?.trim() as `0x${string}` | undefined
  if (!tempo) {
    throw new Error('bridge-in needs HITPAY_TREASURY_PRIVATE_KEY or TEMPO_PRIVATE_KEY in .env')
  }
  return tempo
}

export interface SendUsdcResult {
  tx_hash: `0x${string}`
  block: bigint
  treasury: `0x${string}`
  recipient: `0x${string}`
  amount_usdc: string
}

export async function sendUsdcOnTempo(args: {
  recipient: `0x${string}`
  amountUsd: string
}): Promise<SendUsdcResult> {
  const account = privateKeyToAccount(resolveTreasuryKey())
  const transport = http(TEMPO_TESTNET_RPC)
  const chain = await resolveChain()
  const wallet = createWalletClient({ account, chain, transport })
  const reader = createPublicClient({ chain, transport })

  const value = parseUnits(args.amountUsd, USDC_DECIMALS)
  const txHash = await wallet.writeContract({
    chain,
    address: USDC,
    abi: erc20,
    functionName: 'transfer',
    args: [args.recipient, value],
  })
  const receipt = await reader.waitForTransactionReceipt({ hash: txHash })
  return {
    tx_hash: txHash,
    block: receipt.blockNumber,
    treasury: account.address,
    recipient: args.recipient,
    amount_usdc: args.amountUsd,
  }
}
