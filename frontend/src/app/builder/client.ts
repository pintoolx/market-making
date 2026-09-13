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
export type RequirementReviewCriterion = { criterion: Record<string, unknown>; enforcement: 'onchain_enforced' | 'preflight_only' | 'informational' | 'unsupported';
  matchesDraft: boolean | null; interpretation: string; actual: string | null; limitation: string; evidence: string };
export type RequirementReviewRow = { id: string; text: string; priority: 'must' | 'prefer'; sourceMessageId: string; criteria: RequirementReviewCriterion[]; needsInterpretation: boolean };
export type RequirementReview = { schemaVersion: 1; engineVersion: string; id: string; owner: string; draftId: string; revision: number;
  contentDigest: `0x${string}`; manifestHash: `0x${string}`; draft: Draft; requirements: RequirementReviewRow[]; compilation: unknown;
  expiresAt: string; registrationReady: false };
export type RequirementReceipt = { schemaVersion: 1; engineVersion: string; reviewId: string; reviewDigest: `0x${string}`; owner: string;
  draftId: string; fromRevision: number; revision: number; contentDigest: `0x${string}`; manifestHash: `0x${string}`;
  decisions: { requirementId: string; decision: 'confirm' | 'accept-limitation' }[]; userConfirmed: true; needsRecompile: boolean;
  confirmedAt: string; registrationReady: false };
export type AutomationConsentIntent = { schemaVersion: 1; id: string; owner: string; draftId: string; revision: number; artifactId: string;
  contentDigest: `0x${string}`; manifestHash: `0x${string}`; strategyHash: `0x${string}`; scope: 'standing-report-delivery'; expiresAt: string;
  message: string; registrationReady: false };
export type AutomationConsent = { schemaVersion: 1; id: string; intentId: string; owner: string; draftId: string; revision: number; artifactId: string;
  contentDigest: `0x${string}`; manifestHash: `0x${string}`; strategyHash: `0x${string}`; scope: 'standing-report-delivery'; expiresAt: string;
  message: string; signature: `0x${string}`; consentDigest: `0x${string}`; active: boolean; registrationReady: false };
export type EventSubscription = { id: string; owner: string; draftId: string; revision: number; artifactId: string; consentId: string; generation: number;
  state: 'enabled' | 'paused' | 'stopped'; lastEventAt: string | null; lastInputObservedAt: string | null; lastEvaluatedAt: string | null;
  lastChangedAt: string | null; lastReportHash: `0x${string}` | null; lastReportNonce: string | null; stoppedAt: string | null };
export type AuthorizationBinding = { schemaVersion: 1; id: string; intentId: string; owner: string; draftId: string; revision: number; artifactId: string;
  manifestHash: `0x${string}`; contentDigest: `0x${string}`; maker: string; guard: string; router: string; strategyHash: `0x${string}`; programHash: `0x${string}`;
  orderHash: `0x${string}`; reportSchema: 2; reportDigest: `0x${string}`; reportTransactionHash: `0x${string}`; reportNonce: string;
  makerMessage: string; makerSignature: `0x${string}`; bindingDigest: `0x${string}`; registrationReady: false };
export type Turn = { id: string; state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'superseded'; messageId: string | null };
export type TurnEvent = { sequence: string; attempt: number; kind: 'started' | 'text' | 'tool' | 'completed' | 'failed' | 'cancelled' | 'superseded'; payload: { text?: string; name?: string; ok?: boolean } };

export class BuilderError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(({ 'authentication-required': '工作區登入已失效，請重新驗證錢包。', 'privy-authentication-required': '登入已失效，請重新登入 Privy。',
      'agent-turn-active': '這份策略仍在回覆中，請等待或先停止生成。', 'draft-changed': '策略已更新，請重新載入後再送出。',
      'revision-or-template-conflict': '策略版本已變更，請查看最新設定後再修改。', 'agent-hourly-budget': '這個錢包本小時的對話額度已用完，請稍後再試。',
      'design-unavailable': '策略對話服務尚未開放，已保存的草稿仍可查看。', 'not-found': '找不到這份策略，或目前錢包無法存取。',
      'templates-unavailable': '模板發布與套用服務尚未開放。', 'template-withdrawn': 'Provider 已撤下這個版本，不能新增套用。',
      'template-version-changed': '已有新的版本發布，請重新取得發布審閱。', 'publication-intent-expired': '發布審閱已過期，請重新審閱並簽名。',
      'template-price-unavailable': '目前無法取得可信行情，請稍後再套用。', 'template-price-stale': '行情已過時，請重新套用以取得最新資料。',
      'invalid-publication-signature': '發布簽名與目前錢包或審閱內容不符。', 'invalid-withdrawal-signature': '撤下簽名與版本不符。',
      'template-expired': '此版本的策略期限已到，請選擇其他版本。', 'template-profile-stale': '此模板使用較舊的部署設定，請選擇目前可用版本。',
      'template-encryption-key-unavailable': '此版本的政策金鑰目前無法使用，請選擇其他版本。', 'template-budget-exhausted': '本小時的模板操作額度已用完，請稍後再試。',
      'template-instance-invalid': '配置不符合此模板的公開上限，請檢查數量。', 'publication-context-changed': '發布設定已更新，請重新取得審閱。',
      'inventory-unavailable': '資產讀取服務尚未開放。', 'inventory-read-unavailable': '目前無法核對鏈上資產，請稍後重讀。',
      'inventory-busy': '資產讀取繁忙，請稍後重試。', 'simulation-unavailable': '模擬服務尚未開放或暫時無法執行。',
      'simulation-artifact-stale': '草稿或編譯版本已變更，請回到策略重新編譯。', 'simulation-hourly-budget': '本小時的模擬額度已用完，請稍後再試。',
      'strategy-incomplete-or-invalid': '公開設定或 Maker 配置尚未完整，請先回到對話修正。', 'compile-rejected': '編譯器拒絕這組參數，請回到對話檢查曲線與數量。',
      'requirement-review-required': '發布前必須先逐項確認策略條件。', 'requirement-interpretation-required': '需求仍缺少可核對的具體解讀，請先回到對話補充。',
      'requirement-review-expired': '需求審閱已過期，請重新準備審閱。', 'requirement-review-mismatch': '策略或部署設定已變更，請重新準備審閱。',
      'requirement-review-already-confirmed': '這份需求審閱已經完成，請使用最新版本。', 'requirement-compilation-required': 'Maker 必須先編譯目前版本才能審閱。',
      'requirement-artifact-integrity': '編譯結果與目前策略不一致，請重新編譯。', 'requirement-review-budget': '本小時的需求審閱額度已用完，請稍後再試。',
      'automation-consent-required': '啟用持續成交前，必須先由 Maker 明確簽署事件管理同意。', 'automation-consent-expired': '事件管理同意已過期，請重新簽署。',
      'automation-consent-mismatch': '策略或編譯版本已變更，請重新準備事件管理同意。', 'automation-consent-integrity': '事件管理同意資料無法核對，請重新載入。',
      'invalid-automation-consent-signature': '事件管理同意簽名與目前錢包不符。', 'invalid-automation-revoke-signature': '撤銷事件管理同意的簽名不符。',
      'authorization-binding-required': '尚未核對最新的 Guard report 與策略綁定，暫時不能啟用事件管理。', 'binding-proof-unavailable': '目前無法取得可信 Guard report 證據。',
      'binding-proof-mismatch': 'Guard report 與目前策略版本不符，請重新核對。', 'authorization-binding-expired': '綁定審閱已過期，請重新核對 Guard report。',
      'authorization-binding-mismatch': '綁定內容或策略版本已變更，請重新核對。', 'authorization-binding-integrity': '綁定資料無法核對，請重新載入。',
    } as Record<string, string>)[code] ?? '暫時無法連線到策略工作區，請重試。');
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
    requirementReview: async (draft: Draft) => (await call<{ receipt: RequirementReceipt | null; revision: number; registrationReady: false }>(
      `/drafts/${draft.id}/requirement-review?revision=${draft.revision}`)).receipt,
    prepareRequirementReview: (draft: Draft, key: string) => call<{ review: RequirementReview; digest: `0x${string}` }>(
      `/drafts/${draft.id}/requirement-review`, { expectedRevision: draft.revision }, key),
    confirmRequirementReview: (reviewId: string, digest: `0x${string}`, decisions: { requirementId: string; decision: 'confirm' | 'accept-limitation' }[], key: string) =>
      call<{ receipt: RequirementReceipt }>(`/requirement-reviews/${reviewId}/confirm`, { digest, decisions }, key),
    automationConsent: async (draft: Draft) => (await call<{ consent: AutomationConsent | null; revision: number; registrationReady: false }>(
      `/drafts/${draft.id}/automation-consent?revision=${draft.revision}`)).consent,
    prepareAutomationConsent: (draft: Draft, artifactId: string, key: string) => call<{ intent: AutomationConsentIntent; digest: `0x${string}` }>(
      `/drafts/${draft.id}/automation-consent`, { expectedRevision: draft.revision, artifactId }, key),
    confirmAutomationConsent: (intentId: string, digest: `0x${string}`, signature: `0x${string}`, key: string) => call<{ consent: AutomationConsent }>(
      `/automation-consents/${intentId}/confirm`, { digest, signature }, key),
    revokeAutomationConsent: (consentId: string, signature: `0x${string}`, key: string) => call<{ consent: AutomationConsent }>(
      `/automation-consents/${consentId}/revoke`, { signature }, key),
    eventSubscription: async (draft: Draft) => (await call<{ subscription: EventSubscription | null; revision: number; registrationReady: false }>(
      `/drafts/${draft.id}/event-subscription?revision=${draft.revision}`)).subscription,
    enableEventSubscription: (draft: Draft, artifactId: string, consentId: string, key: string) => call<{ subscription: EventSubscription }>(
      `/drafts/${draft.id}/event-subscription`, { expectedRevision: draft.revision, artifactId, consentId }, key),
    stopEventSubscription: (subscriptionId: string, key: string) => call<{ subscription: EventSubscription }>(
      `/event-subscriptions/${subscriptionId}/stop`, {}, key),
    authorizationBinding: async (draft: Draft) => (await call<{ binding: AuthorizationBinding | null; revision: number; registrationReady: false }>(
      `/drafts/${draft.id}/authorization-binding?revision=${draft.revision}`)).binding,
    prepareAuthorizationBinding: (draft: Draft, artifactId: string, reportDigest: `0x${string}`, reportTransactionHash: `0x${string}`, reportNonce: string, key: string) =>
      call<{ intent: { id: string; message: string; registrationReady: false }; digest: `0x${string}` }>(`/drafts/${draft.id}/authorization-binding`,
        { expectedRevision: draft.revision, artifactId, reportDigest, reportTransactionHash, reportNonce }, key),
    confirmAuthorizationBinding: (intentId: string, digest: `0x${string}`, signature: `0x${string}`, key: string) => call<{ binding: AuthorizationBinding }>(
      `/authorization-bindings/${intentId}/confirm`, { digest, signature }, key),
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
