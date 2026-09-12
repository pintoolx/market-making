import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import type { ReleasePointer } from './schema.mjs';
import type { EnsPlatform, EnsProvider, ResolvedName, Delegation } from './chain.mjs';
export type RegistrationPlan = { registry?: Address; resolver?: Address; registrar?: Address; secret?: Hex; duration?: number; commitment?: Hex; readyAt?: number; registered?: boolean };
export type EnsProgress = { title: string; hash?: Hex };
export function ensTransactions(client: PublicClient, wallet: WalletClient, onProgress?: (progress: EnsProgress) => void): {
  prepareRoot(rootName: string, saved?: RegistrationPlan, persist?: (plan: RegistrationPlan) => void): Promise<RegistrationPlan>;
  registerRoot(rootName: string, saved: RegistrationPlan): Promise<void>;
  enablePlatform(rootName: string, saved?: RegistrationPlan, persist?: (plan: RegistrationPlan) => void): Promise<RegistrationPlan>;
  claimProvider(rootName: string, label: string): Promise<EnsPlatform & { provider: EnsProvider | null }>;
  registerStrategy(rootName: string, label: string): Promise<string>;
  publishPointer(rootName: string, name: string, pointer: ReleasePointer): Promise<ResolvedName>;
  delegate(rootName: string, name: string, delegate: Address, grant: boolean): Promise<Delegation>;
};
