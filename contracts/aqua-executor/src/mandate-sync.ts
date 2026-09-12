import type { ExecutionResult } from './execution-controller.ts'

export interface MandateSyncOptions {
  apiUrl: string
  mandateId: string
  providerStrategyId: string
  fetchImpl?: typeof fetch
}

/** Publish only mined Aqua swap evidence; the mandate service independently verifies it from RPC. */
export async function syncMandateExecution(result: ExecutionResult, options: MandateSyncOptions) {
  if (result.action !== 'swap') throw new Error('only Aqua swap results can be attached to a mandate')
  const transaction = result.transactions.find(item => item.action === 'swap')
  if (!transaction || !/^0x[0-9a-f]{64}$/i.test(transaction.hash)) throw new Error('execution has no mined Aqua swap transaction')
  const outcome = transaction.status === 'success' ? 'settled' : transaction.status === 'reverted' ? 'rejected' : null
  if (!outcome) throw new Error('Aqua swap receipt is not final')
  const response = await (options.fetchImpl ?? fetch)(`${options.apiUrl.replace(/\/$/, '')}/v1/mandates/${encodeURIComponent(options.mandateId)}/executions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      providerStrategyId: options.providerStrategyId, transactionHash: transaction.hash, outcome,
    }),
  })
  if (!response.ok) throw new Error(`mandate service rejected Aqua evidence (${response.status})`)
  return response.json()
}
