import { isAddress, zeroAddress, zeroHash, type Abi, type Hex } from 'viem'
import { z } from 'zod'
import artifact from '../../contracts/aqua-executor/artifacts/AquaGuard.json'
import { publicReportSchema } from './report'

export const CHAIN_NAME = 'ethereum-testnet-sepolia-base-1'
export const CHAIN_ID = '84532'
// Official CLI v1.33.0 simulation forwarder, not the project's GuardTestForwarder.
export const SIMULATION_FORWARDER = '0x82300bd7c3958625581cc2f77bc6464dcecdf3e5'
export const receiverAbi = artifact.abi as Abi

export const transportSchema = z.object({
  profile: z.enum(['cre-simulation', 'cre-production']),
  forwarder: z.string().refine(s => isAddress(s, { strict: false }) && s.toLowerCase() !== zeroAddress).transform(s => s.toLowerCase() as Hex),
  workflowId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(s => s.toLowerCase() as Hex),
  workflowOwner: z.string().refine(s => isAddress(s, { strict: false })).transform(s => s.toLowerCase() as Hex),
  gasLimit: z.string().regex(/^[1-9][0-9]{0,6}$/).pipe(z.string().refine(s => BigInt(s) <= 2_000_000n)),
}).strict().superRefine((t, ctx) => {
  if (t.profile === 'cre-simulation'
    ? t.forwarder !== SIMULATION_FORWARDER || t.workflowId !== zeroHash || t.workflowOwner !== zeroAddress
    : t.forwarder === SIMULATION_FORWARDER || t.workflowId === zeroHash || t.workflowOwner === zeroAddress) {
    ctx.addIssue({ code: 'custom', message: 'transport identity does not match the selected profile' })
  }
})

export const configSchema = z.object({
  schedule: z.string().min(1), transport: transportSchema, publicReport: publicReportSchema,
}).strict()
export type Config = z.infer<typeof configSchema>
