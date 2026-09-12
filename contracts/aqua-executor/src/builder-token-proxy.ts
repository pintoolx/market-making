import { keccak256, stringToHex, zeroAddress, type Hex, type PublicClient } from 'viem'
import { addressSchema, type DeploymentProfile } from '@pintool/strategy-builder'

// Circle's UpgradeabilityProxy uses the legacy Zeppelin slot, not the EIP-1967 slot.
// https://github.com/circlefin/stablecoin-evm/blob/master/contracts/upgradeability/UpgradeabilityProxy.sol
const slot = keccak256(stringToHex('org.zeppelinos.proxy.implementation'))
export async function readBuilderTokenImplementation(pc: Pick<PublicClient, 'getStorageAt' | 'getCode'>, profile: DeploymentProfile, blockNumber: bigint) {
  const proxy = profile.tokens.find(t => t.symbol === 'USDC')!.address
  const value = await pc.getStorageAt({ address: proxy, slot, blockNumber })
  if (!value || !/^0x0{24}[0-9a-f]{40}$/i.test(value)) throw new Error('invalid-token-implementation')
  if (`0x${value.slice(-40)}` === zeroAddress) throw new Error('missing-token-implementation')
  const implementation = addressSchema.parse(`0x${value.slice(-40)}`) as Hex
  const code = await pc.getCode({ address: implementation, blockNumber })
  if (!code || code === '0x') throw new Error('empty-token-implementation')
  return { proxy, slot, implementation, codeHash: keccak256(code), runtimeBytes: (code.length - 2) / 2 }
}
