import { getApiBase } from '../marketplace/mandateClient';
import type { PolicyEnvelope, PublicationIntent, StrategyDraft, StrategySpec, TemplatePermissions, TemplateVersion } from '@pintool/strategy-builder';
import type { Compilation, CompilationItem, InventoryResult, SimulationDetail, SimulationItem } from './preparation';

// Public API projection only; the backend owns validation, ownership and transitions.
export type Token = { address: string; symbol: string; decimals: number };
export type Draft = StrategyDraft;
export type TemplateItem = { templateId: string; version: number; digest: `0x${string}`; provider: `0x${string}`; title: string;
  model: 'xyc' | 'concentrated' | 'pegged'; baseToken: Token; quoteToken: Token; deadline: number; withdrawnAt: string | null; currentManifest: boolean;
  policyStatus: 'encrypted-unverified'; registrationReady: false };
export type PublishedTemplate = { template: TemplateVersion; digest: `0x${string}`; proof: { intent: PublicationIntent; message: string; signature: `0x${string}` };
  withdrawnAt: string | null; currentManifest: boolean; policyStatus: 'encrypted-unverified'; registrationReady: false };
export type TemplateContext = { templatePin: NonNullable<Draft['templatePin']>; provider: string; permissions: TemplatePermissions; baseline: StrategySpec;
  makerEditable: string[]; lockedSpecFields: string[]; withdrawn: boolean; registrationReady: false };
export type Conversation = { conversationId: string; draftId: string; title: string; revision: string; activeTurnId: string | null };
export type Message = { id: string; role: 'user' | 'assistant'; content: string; sequence: string };
export type Revision = { revision: string; createdAt: string; diff: { path: string; before: unknown; after: unknown }[] };
export type Validation = { revision: number; ready: boolean; errors: { code: string; path: string; message: string }[]; missingFields: string[] };
export type Turn = { id: string; state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'superseded'; messageId: string | null };
export type TurnEvent = { sequence: string; attempt: number; kind: 'started' | 'text' | 'tool' | 'completed' | 'failed' | 'cancelled' | 'superseded'; payload: { text?: string; name?: string; ok?: boolean } };

export class BuilderError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(({ 'authentication-required': 'Your workspace session expired. Verify your wallet again.', 'privy-authentication-required': 'Your login expired. Sign in with Privy again.',
      'agent-turn-active': 'This strategy is still responding. Wait or stop generation first.', 'draft-changed': 'The strategy changed. Reload before submitting again.',
      'revision-or-template-conflict': 'The strategy version changed. Review the latest parameters before editing.', 'agent-hourly-budget': 'This wallet has reached its hourly conversation limit. Try again later.',
      'design-unavailable': 'Strategy conversations are unavailable. You can still view saved drafts.', 'not-found': 'This strategy was not found or is not accessible to this wallet.',
      'templates-unavailable': 'Template publication and application are unavailable.', 'template-withdrawn': 'The Provider withdrew this version. New instances cannot use it.',
      'template-version-changed': 'A newer version was published. Request a fresh publication review.', 'publication-intent-expired': 'The publication review expired. Review and sign again.',
      'template-price-unavailable': 'Trusted market data is unavailable. Try applying the template again later.', 'template-price-stale': 'Market data is stale. Apply the template again to obtain fresh data.',
      'invalid-publication-signature': 'The publication signature does not match the wallet or reviewed content.', 'invalid-withdrawal-signature': 'The withdrawal signature does not match this version.',
      'template-expired': 'This strategy version expired. Choose another version.', 'template-profile-stale': 'This template uses an older deployment profile. Choose a current version.',
      'template-encryption-key-unavailable': 'The policy key for this version is unavailable. Choose another version.', 'template-budget-exhausted': 'The hourly template operation limit has been reached. Try again later.',
      'template-instance-invalid': 'The allocations exceed the public limits of this template. Review the amounts.', 'publication-context-changed': 'Publication settings changed. Request a new review.',
      'inventory-unavailable': 'Inventory reads are unavailable.', 'inventory-read-unavailable': 'Onchain inventory could not be verified. Try reading it again later.',
      'inventory-busy': 'Inventory reads are busy. Try again shortly.', 'simulation-unavailable': 'Simulation is unavailable or temporarily unable to run.',
      'simulation-artifact-stale': 'The draft or compilation changed. Return to the strategy and compile again.', 'simulation-hourly-budget': 'The hourly simulation limit has been reached. Try again later.',
      'strategy-incomplete-or-invalid': 'Public parameters or Maker allocations are incomplete. Complete them in the conversation first.', 'compile-rejected': 'The compiler rejected these parameters. Review the curve and amounts in the conversation.',
    } as Record<string, string>)[code] ?? 'Unable to connect to the strategy workspace. Please retry.');
  }
}

/** Credentials stay inside this browser closure. Never serialize them into a chat/tool payload. */
export function builderClient(identity: { getAccessToken(): Promise<string | null>; signMessage(message: string): Promise<`0x${string}`>; address: string }) {
  let session: string | undefined;
  async function call<T>(path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const access = await identity.getAccessToken().catch(() => null);
    if (!access) throw new BuilderError(401, 'privy-authentication-required');
    const response = await fetch(getApiBase() + '/v1/builder' + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-privy-access-token': access, ...(session ? { authorization: 'Bearer ' + session } : {}),
        ...(body === undefined ? {} : { 'idempotency-key': idempotencyKey ?? crypto.randomUUID() }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).catch(() => { throw new BuilderError(0, 'unavailable'); });
    const value = await response.json().catch(() => null);
    if (!response.ok || !value) throw new BuilderError(response.status, typeof value?.error === 'string' ? value.error : 'unavailable');
    return value as T;
  }
  return {
    async connect() {
      const challenge = await call<{ id: string; message: string }>('/auth/challenge', { address: identity.address });
      const result = await call<{ token: string }>('/auth/login', { challengeId: challenge.id, signature: await identity.signMessage(challenge.message) });
      session = result.token;
    },
    async disconnect() { try { if (session) await call('/auth/logout', {}); } finally { session = undefined; } },
    list: () => call<{ conversations: Conversation[] }>('/conversations'),
    create: (title: string, key: string) => call<{ conversationId: string; draft: Draft }>('/conversations', { title, kind: 'template' }, key),
    draft: (id: string) => call<{ draft: Draft }>(`/drafts/${id}`),
    history: (id: string) => call<{ revisions: Revision[] }>(`/drafts/${id}/history`),
    validate: (id: string) => call<Validation>(`/drafts/${id}/validation`),
    messages: (id: string) => call<{ messages: Message[] }>(`/conversations/${id}/messages`),
    start: (id: string, expectedRevision: number, content: string, key: string) => call<{ id: string }>(`/conversations/${id}/turns`, { expectedRevision, content }, key),
    turn: (id: string) => call<{ turn: Turn }>(`/turns/${id}`),
    events: (id: string, after: string) => call<{ events: TurnEvent[] }>(`/turns/${id}/events?after=${encodeURIComponent(after)}`),
    cancel: (id: string) => call(`/turns/${id}/cancel`, {}),
    restore: (id: string, expectedRevision: number, revision: number, key: string) => call<{ draft: Draft }>(`/drafts/${id}/restore`, { expectedRevision, revision }, key),
    templates: () => call<{ templates: TemplateItem[] }>('/templates'),
    template: (id: string, version: number) => call<PublishedTemplate>(`/templates/${encodeURIComponent(id)}/versions/${version}`),
    templateContext: async (id: string, revision: number) => (await call<{ context: TemplateContext | null }>(`/drafts/${id}/template-context?revision=${revision}`)).context,
    inventory: (draft: Draft) => call<InventoryResult>(`/drafts/${draft.id}/inventory?revision=${draft.revision}`),
    compilations: (id: string) => call<{ artifacts: CompilationItem[] }>(`/drafts/${id}/artifacts`),
    compilation: (id: string) => call<Compilation>(`/artifacts/${id}`),
    compile: (draft: Draft, key: string) => call<{ artifactId: string; draftId: string; revision: number }>(`/drafts/${draft.id}/compile`, { expectedRevision: draft.revision }, key),
    simulations: (id: string) => call<{ simulations: SimulationItem[] }>(`/drafts/${id}/simulations`),
    simulation: (id: string) => call<SimulationDetail>(`/simulations/${id}`),
    simulate: (artifactId: string, revision: number, key: string) => call<{ id: string; artifactId: string; draftId: string; revision: number }>(`/artifacts/${artifactId}/simulations`, { expectedRevision: revision }, key),
    cancelSimulation: (id: string, key: string) => call<{ id: string; state: string }>(`/simulations/${id}/cancel`, {}, key),
    preparePublication: (draft: Draft, templateId: string | null, permissions: TemplatePermissions, key: string) => call<{ intent: PublicationIntent }>(
      '/templates/prepare', { draftId: draft.id, expectedRevision: draft.revision, templateId, permissions }, key),
    publish: (intentId: string, envelope: PolicyEnvelope, signature: `0x${string}`, key: string) => call<PublishedTemplate>('/templates/publish', { intentId, envelope, signature }, key),
    withdraw: (version: PublishedTemplate, signature: `0x${string}`, key: string) => call<PublishedTemplate>('/templates/withdraw', {
      templateId: version.template.templateId, version: version.template.version, digest: version.digest, signature,
    }, key),
    instantiate: (version: PublishedTemplate, allocations: { baseAtomic: string; quoteAtomic: string }, title: string, key: string) => call<{ conversationId: string; draft: Draft }>('/templates/instantiate', {
      templateId: version.template.templateId, version: version.template.version, digest: version.digest, allocations, title,
    }, key),
  };
}
export type BuilderClient = ReturnType<typeof builderClient>;
