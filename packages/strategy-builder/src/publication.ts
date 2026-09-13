import { z } from 'zod'
import { canonical, digestJson, DraftConflict } from './drafts.ts'
import { hashSchema, idSchema } from './schema.ts'
import { templateDigest, templateVersionSchema, type TemplateVersion } from './templates.ts'

/** Same wire shape and ciphertext size as workflow/src/confidential-envelope.ts.
 * This module never accepts plaintext policy rules. */
export const policyEnvelopeSchema = z.object({ version: z.literal(1),
  ephemeralPublicKey: z.string().regex(/^[0-9a-f]{64}$/), nonce: z.string().regex(/^[0-9a-f]{48}$/),
  ciphertext: z.string().regex(/^(?:[0-9a-f]{2}){16,4096}$/),
}).strict()
export type PolicyEnvelope = z.infer<typeof policyEnvelopeSchema>
export const workflowKeySchema = z.string().regex(/^[0-9a-f]{64}$/).refine(v => !/^0+$/.test(v), 'invalid public encryption key')
export const signatureSchema = z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform(v => v.toLowerCase() as `0x${string}`)
export const publicationIntentSchema = z.object({
  id: idSchema, origin: z.string().url(), chainId: z.number().int().positive(), expiresAt: z.string().datetime(),
  base: templateVersionSchema.omit({ policy: true }),
  encryption: z.object({ algorithm: z.literal('x25519-hkdf-sha256-xchacha20poly1305'), keyId: hashSchema,
    publicKey: workflowKeySchema, strategyId: idSchema }).strict(),
}).strict()
export type PublicationIntent = z.infer<typeof publicationIntentSchema>
export function publicationVersion(intentInput: PublicationIntent, envelopeInput: PolicyEnvelope): TemplateVersion {
  const intent = publicationIntentSchema.parse(intentInput), envelope = policyEnvelopeSchema.parse(envelopeInput)
  if (intent.encryption.keyId !== digestJson({ algorithm: intent.encryption.algorithm, publicKey: intent.encryption.publicKey }) ||
    intent.encryption.strategyId !== `${intent.base.templateId}.v${intent.base.version}`) throw new DraftConflict('publication-context-mismatch')
  return templateVersionSchema.parse({ ...intent.base, policy: { keyId: intent.encryption.keyId, envelopeDigest: digestJson(envelope) } })
}
/** EIP-191 wallet signatures bind the entire public version, encrypted policy,
 * exact application origin and one expiring server intent. Never a transaction. */
export function publicationMessage(intentInput: PublicationIntent, envelope: PolicyEnvelope) {
  const intent = publicationIntentSchema.parse(intentInput), version = publicationVersion(intent, envelope)
  return publicationVersionMessage(intent, version)
}
export function publicationVersionMessage(intentInput: PublicationIntent, versionInput: TemplateVersion) {
  const intent = publicationIntentSchema.parse(intentInput), version = templateVersionSchema.parse(versionInput)
  const { policy, ...base } = version
  if (canonical(base) !== canonical(intent.base) || policy.keyId !== intent.encryption.keyId ||
    intent.encryption.keyId !== digestJson({ algorithm: intent.encryption.algorithm, publicKey: intent.encryption.publicKey }) ||
    intent.encryption.strategyId !== `${intent.base.templateId}.v${intent.base.version}`) throw new DraftConflict('publication-context-mismatch')
  return `Publish Pintool Provider template\n\nThis publishes an immutable template version. It does not move tokens or activate an LP.\n\n${canonical({
    domain: 'pintool/builder-publication/v1', action: 'publish', origin: intent.origin, chainId: intent.chainId,
    intentId: intent.id, expiresAt: intent.expiresAt, version, versionDigest: templateDigest(version),
  })}`
}
export function withdrawalMessage(origin: string, chainId: number, input: TemplateVersion) {
  const version = templateVersionSchema.parse(input)
  z.string().url().parse(origin); z.number().int().positive().parse(chainId)
  return `Withdraw Pintool Provider template version\n\nThis permanently closes this version to new Maker instances. Existing instances require separate authorization revocation.\n\n${canonical({
    domain: 'pintool/builder-publication/v1', action: 'withdraw', origin, chainId, provider: version.provider,
    templateId: version.templateId, version: version.version, versionDigest: templateDigest(version),
  })}`
}
