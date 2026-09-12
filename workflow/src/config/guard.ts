/** Public Ethereum Sepolia asset/delivery configuration. Guard and router are supplied
 * by each workflow config from the confirmed deployments/11155111.json bundle.
 * The simulation forwarder is not a production DON identity; verify the current
 * tenant's supported-chains output before a real CRE broadcast.
 */
export const GUARD_CONFIG = {
  chainId: 11155111n,
  chainSelectorName: 'ethereum-testnet-sepolia',
  token0: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
  token1: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
  decimals0: 18,
  decimals1: 6,
  creMockForwarder: '0x15fc6ae953e024d975e77382eeec56a9101f9f88',
  onReportSignature: 'onReport(bytes,bytes)',
  writeReportGasLimit: '500000',
} as const
export type GuardConfig = typeof GUARD_CONFIG
