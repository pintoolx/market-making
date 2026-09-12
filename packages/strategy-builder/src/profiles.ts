import { AQUA_COMMIT, AQUA_OPCODES, SWAPVM_COMMIT } from './capabilities.ts'
import { digestJson } from './drafts.ts'
import type { DeploymentProfile } from './validation.ts'

/** A deployment definition is not a live verification receipt; transaction readiness verifies it separately. */
export const sepoliaStandingProfile: DeploymentProfile = {
  id: 'sepolia-standing-v2', chainId: 11155111,
  aqua: '0x1111113ccf1426a8e30e2bff5e005d929bf6a90a', router: '0x47a875f39ba4b0d0beaa928bb071d4b4da0b4092',
  guard: '0x64f6e18e85dae5ec2ee44fe7f9fc66cf2a1f056f', forwarder: '0x15fc6ae953e024d975e77382eeec56a9101f9f88', guardRevision: 'standing-v2',
  swapVmCommit: SWAPVM_COMMIT, aquaCommit: AQUA_COMMIT, swapVmSdk: '0.4.4', aquaSdk: null,
  opcodeTableHash: digestJson(AQUA_OPCODES), tokens: [
    { address: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14', symbol: 'WETH', decimals: 18 },
    { address: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', symbol: 'USDC', decimals: 6 },
  ],
}
