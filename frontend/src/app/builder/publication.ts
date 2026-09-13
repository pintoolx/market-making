import { verifyMessage } from 'viem';
import { canonical, contentDigest, digestJson, publicationIntentSchema, publicationVersionMessage,
  sepoliaStandingProfile, signatureSchema, templateDigest, templateVersionSchema, type PublicationIntent, type TemplatePermissions } from '@pintool/strategy-builder';
import type { Draft, PublishedTemplate } from './client';

/** Checks what the user is about to sign against the visible draft and application.
 * Private rules are not inputs to this public review function. */
export function verifyPublicationIntent(input: PublicationIntent, draft: Draft, permissions: TemplatePermissions, templateId: string | null, origin: string) {
  const intent = publicationIntentSchema.parse(input);
  if (intent.origin !== origin || intent.chainId !== sepoliaStandingProfile.chainId || intent.base.manifestHash !== digestJson(sepoliaStandingProfile) ||
    intent.base.provider !== draft.owner.slice(7) || intent.base.source.draftId !== draft.id || intent.base.source.revision !== draft.revision ||
    intent.base.source.contentDigest !== contentDigest(draft) || canonical(intent.base.spec) !== canonical(draft.spec) ||
    canonical(intent.base.requirements) !== canonical(draft.requirements) || canonical(intent.base.permissions) !== canonical(permissions) ||
    intent.encryption.keyId !== digestJson({ algorithm: intent.encryption.algorithm, publicKey: intent.encryption.publicKey }) ||
    intent.encryption.strategyId !== `${intent.base.templateId}.v${intent.base.version}` ||
    (templateId && intent.base.templateId !== templateId) || Date.parse(intent.expiresAt) <= Date.now() || Date.parse(intent.expiresAt) > Date.now() + 301000) {
    throw new Error('發布審閱與目前畫面不符，請重新載入。');
  }
  return intent;
}

/** Verify the exact Provider public version locally before presenting an apply/withdraw action. */
export async function verifyPublishedTemplate(input: PublishedTemplate, id: string, version: number, digest?: string) {
  const template = templateVersionSchema.parse(input.template), intent = publicationIntentSchema.parse(input.proof.intent);
  const message = publicationVersionMessage(intent, template), signature = signatureSchema.parse(input.proof.signature);
  if (template.templateId !== id || template.version !== version || templateDigest(template) !== input.digest ||
    (digest && input.digest !== digest) || message !== input.proof.message || intent.chainId !== sepoliaStandingProfile.chainId ||
    !await verifyMessage({ address: template.provider, message, signature })) throw new Error('模板簽名或版本無法核對，請重新載入。');
  return { ...input, template, proof: { intent, message, signature }, currentManifest: template.manifestHash === digestJson(sepoliaStandingProfile) };
}
