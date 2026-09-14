import type { Pool } from 'pg'
import type { DeploymentProfile } from '../../packages/strategy-builder/src/index.ts'
import type { EventDeliveryDependencies, DeliveryReconciliation } from '../../packages/builder-service/src/event-delivery.ts'
import type { WorkflowInputReference } from '../../packages/builder-service/src/workflow-input.ts'
import type { BuilderReport } from './builder-cre-protocol.mjs'
interface TrustedInput {
  bindingDigest: string;
  config: { maker: string; strategyHash: string; builderEnvelope: Record<string, string>; [key: string]: unknown };
  payload: { maker: string; strategyHash: string; [key: string]: unknown };
}
interface BridgeOptions {
  baseConfig: Record<string, unknown>; origin?: string; workflowPublicKey?: string; rpcUrl?: string;
  projectDirectory?: string; environmentFile?: string; env?: Record<string, string | undefined>;
  timeoutMs?: number; broadcastEnabled?: boolean;
}
interface BridgeDependencies {
  load?: (reference: WorkflowInputReference) => Promise<TrustedInput>;
  simulate?: (input: { config: TrustedInput['config']; payload: TrustedInput['payload'] & { requestId: string; builder: { phase: 'evaluate' | 'deliver'; nonce?: string; validAfter?: string; deliveryId?: string; termsHash?: string } } }) => Promise<Record<string, unknown>>;
  chain?: {
    snapshot(maker: string, strategyHash: string): Promise<{ fromBlock: string; nonceFloor: string; termsHash: string | null; activeHash: string }>;
    accepted(input: { report: BuilderReport; fromBlock: string; transactionHash?: string }): Promise<DeliveryReconciliation>;
  };
}
export function createBuilderCreBridge(pool: Pool, profile: DeploymentProfile, options: BridgeOptions, dependencies?: BridgeDependencies): EventDeliveryDependencies
