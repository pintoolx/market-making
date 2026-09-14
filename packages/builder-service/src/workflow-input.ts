import type { Pool, PoolClient } from 'pg'
import { keccak256, stringToHex, verifyMessage } from 'viem'
import { compileBuilderStrategy } from 'aqua-executor/builder'
import { canonical, digestJson, policyEnvelopeSchema, publicationIntentSchema, publicationVersion,
  publicationVersionMessage, templateDigest, workflowKeySchema, type DeploymentProfile } from '@pintool/strategy-builder'
import { readCompiledArtifact } from './artifacts.ts'
import { readActiveAutomationConsent } from './automation.ts'
import { readTemplateContext } from './templates.ts'
import { readRequirementReceipt } from './requirement-reviews.ts'
import { transaction } from './database.ts'
import { conflict, ServiceError } from './errors.ts'

export type WorkflowInputReference = { owner: string; draftId: string; revision: number; artifactId: string; consentId: string }
export type WorkflowInputOptions = { origin: string; workflowPublicKey: string }

/** Trusted worker boundary. This result includes ciphertext and MUST NOT be
 * returned by an ordinary Builder API, design tool, log or outbox. No plaintext
 * policy or decryption key is read here. All authority is reconstructed from
 * durable signatures and a fresh deterministic compilation, never HTTP fields.
 */
export async function readTrustedWorkflowInput(client: Pick<PoolClient, 'query'>, profile: DeploymentProfile,
  reference: WorkflowInputReference, options: WorkflowInputOptions) {
  const artifact = await readCompiledArtifact(client, profile, reference.owner, reference.artifactId)
  const { draft, payload } = artifact
  if (!artifact.current || draft.id !== reference.draftId || draft.revision !== reference.revision || draft.maker !== reference.owner.slice(7))
    throw conflict('workflow-instance-stale')
  const compiled = compileBuilderStrategy(draft, profile, Math.floor(Date.now() / 1000))
  if (canonical(compiled) !== canonical(payload)) throw new ServiceError('workflow-compile-integrity', 500)
  if (draft.requirements.length && !await readRequirementReceipt(client, profile, draft)) throw conflict('requirement-review-required')
  const consent = await readActiveAutomationConsent(client, reference.owner, draft.id, draft.revision)
  if (!consent || consent.id !== reference.consentId || consent.artifactId !== reference.artifactId ||
    consent.strategyHash !== compiled.strategyHash || consent.contentDigest !== compiled.contentDigest || consent.manifestHash !== compiled.manifestHash)
    throw conflict('workflow-consent-required')
  const context = await readTemplateContext(client, draft)
  if (!context) throw conflict('workflow-provider-template-required')
  const { template } = context
  const publicKey = workflowKeySchema.parse(options.workflowPublicKey)
  const row = (await client.query(`SELECT v.signature,i.payload AS intent,i.digest AS intent_digest,
    p.key_id,p.envelope_digest,p.envelope
    FROM builder.template_versions v JOIN builder.publication_intents i ON i.id=v.intent_id
    JOIN builder_private.provider_policies p ON p.template_id=v.template_id AND p.version=v.version
    WHERE v.template_id=$1 AND v.version=$2`, [template.templateId, template.version])).rows[0]
  if (!row) throw new ServiceError('workflow-provider-policy-unavailable', 503)
  const intent = publicationIntentSchema.parse(row.intent), envelope = policyEnvelopeSchema.parse(row.envelope)
  if (digestJson(intent) !== row.intent_digest || intent.origin !== options.origin || intent.chainId !== profile.chainId ||
    intent.encryption.publicKey !== publicKey || row.key_id !== template.policy.keyId ||
    row.envelope_digest !== template.policy.envelopeDigest || digestJson(envelope) !== row.envelope_digest ||
    templateDigest(publicationVersion(intent, envelope)) !== templateDigest(template))
    throw new ServiceError('workflow-provider-policy-integrity', 500)
  let signed = false
  try { signed = await verifyMessage({ address: template.provider, message: publicationVersionMessage(intent, template), signature: row.signature }) } catch { /* redact */ }
  if (!signed) throw new ServiceError('workflow-provider-signature-invalid', 500)
  const caps = compiled.decoded.guardEnvelope
  const config = {
    maker: compiled.decoded.maker, guard: profile.guard, router: profile.router, strategyHash: compiled.strategyHash,
    builderSimulation: true as const,
    builderEnvelope: { maxAmount0PerSwap: caps.maxAmountBasePerSwap, maxAmount1PerSwap: caps.maxAmountQuotePerSwap,
      maxPostBalance0: caps.maxPostBalanceBase, maxPostBalance1: caps.maxPostBalanceQuote },
    providerBindings: [{ strategyHash: compiled.strategyHash, provider: template.provider,
      strategyId: intent.encryption.strategyId, envelopeHash: keccak256(stringToHex(JSON.stringify(envelope))) }],
  }
  const bindingDigest = digestJson({ reference, config, consentDigest: consent.consentDigest, templateDigest: templateDigest(template) })
  return { bindingDigest, config, outagePolicy: consent.outagePolicy, payload: { maker: config.maker, strategyHash: config.strategyHash,
    provider: template.provider, providerStrategyEnvelope: envelope } }
}

export function createTrustedWorkflowInput(pool: Pool, profile: DeploymentProfile, options: WorkflowInputOptions) {
  return (reference: WorkflowInputReference) => transaction(pool, async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    return readTrustedWorkflowInput(client, profile, reference, options)
  })
}
