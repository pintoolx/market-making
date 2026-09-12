import { getApiBase } from '../marketplace/mandateClient';

// Public API projection only; the backend owns validation, ownership and transitions.
export type Token = { address: string; symbol: string; decimals: number };
export type Draft = {
  id: string; revision: number; kind: 'template' | 'maker'; maker?: string;
  spec: { title: string; profileId: string; baseToken?: Token; quoteToken?: Token;
    model?: { kind: 'xyc' | 'concentrated' | 'pegged'; minPrice?: string; maxPrice?: string; relativeWidthBps?: number; referencePrice?: string; amplification?: string };
    feeBps?: number; deadline?: number; guardEnvelope?: Record<'maxAmountBasePerSwap' | 'maxAmountQuotePerSwap' | 'maxPostBalanceBase' | 'maxPostBalanceQuote', string>;
  };
  allocations?: { baseAtomic: string; quoteAtomic: string };
  requirements: { id: string; text: string; priority: 'must' | 'prefer' }[];
};
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
  };
}
