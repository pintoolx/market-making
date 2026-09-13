import { getApiBase } from '../marketplace/mandateClient';
import type { PolicyEnvelope, PublicationIntent, StrategyDraft, StrategySpec, TemplatePermissions, TemplateVersion } from '@pintool/strategy-builder';

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
