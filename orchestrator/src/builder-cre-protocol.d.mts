export type BuilderReport = Record<'schemaVersion' | 'chainId' | 'guard' | 'router' | 'maker' | 'strategyHash' | 'token0' | 'token1' | 'nonce' | 'validAfter' | 'validUntil' | 'allowedDirections' | 'maxAmount0PerSwap' | 'maxAmount1PerSwap' | 'maxPostBalance0' | 'maxPostBalance1', string>
export function builderTermsHash(input: unknown): `0x${string}`
export function encodeBuilderReport(input: unknown): { report: BuilderReport; payload: `0x${string}`; digest: `0x${string}` }
