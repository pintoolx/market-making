export type ClmmExecution = {
  curve: 'concentrated'; chainId: 11155111; pair: 'WETH/USDC'; feeBps: 0;
  rangeBelowBps: number; rangeAboveBps: number; ttlSec: number;
  maxAmount0PerSwap: string; maxAmount1PerSwap: string; maxPostBalance0: string; maxPostBalance1: string;
};
export type LpRelease = {
  schema: 'pintool-lp-release-v1'; id: string; version: number; provider: string;
  name: string; summary: string; state: 'published' | 'withdrawn'; execution: ClmmExecution;
};
export type SealedPolicy = { version: 1; ephemeralPublicKey: string; nonce: string; ciphertext: string };
export const LP_CAPABILITIES: Record<string, { publication: boolean; reason?: string }>;
export function parseRelease(value: unknown): LpRelease;
export function parseEnvelope(value: unknown): SealedPolicy;
export function publicationMessage(release: unknown, envelope: unknown): string;
export function percentToBps(value: string): number;
export function providerPolicy(release: unknown, volatilityBpsMax: number): {
  schemaVersion: 1; strategyId: string;
  rules: { id: string; when: { volatilityBpsMax: number }; allowMakerBuyToken0: boolean; allowMakerSellToken0: boolean; maxAmount0PerSwap: string; maxAmount1PerSwap: string; ttlSec: number }[];
  inventory: { maxBalance0: string; maxBalance1: string };
};
