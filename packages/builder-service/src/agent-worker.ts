import type { Pool } from 'pg'
import type { LanguageModel, ModelMessage } from 'ai'
import type { DeploymentProfile } from '@pintool/strategy-builder'
import { createStore } from './store.ts'
import { createTurns, type ClaimedTurn } from './turns.ts'
import { createDesignAgent } from './design-agent.ts'
import { createArtifacts } from './artifacts.ts'
import { createSimulations } from './simulations.ts'

/** One durable turn; called by a long-lived worker, never owned by an HTTP connection. */
export async function runDesignTurn(pool: Pool, profile: DeploymentProfile, model: LanguageModel, turn: ClaimedTurn, signal?: AbortSignal, preparation: { simulationEnabled?: boolean } = {}) {
  const turns = createTurns(pool), store = createStore(pool, profile.id, turn), artifacts = createArtifacts(pool, profile, turn), abort = new AbortController()
  const simulations = createSimulations(pool, profile, turn)
  const combined = AbortSignal.any([abort.signal, AbortSignal.timeout(180000), ...(signal ? [signal] : [])])
  let heartbeatBusy = false
  const heartbeat = setInterval(async () => {
    if (heartbeatBusy) return
    heartbeatBusy = true
    try { await turns.heartbeat(turn) } catch { abort.abort() } finally { heartbeatBusy = false }
  }, 10000)
  heartbeat.unref()
  try {
    await store.get(turn.owner, turn.draftId)
    const history = await store.messages(turn.owner, turn.conversationId)
    const messages: ModelMessage[] = []
    let remaining = 48000
    for (const message of history.slice(-30).reverse()) {
      if (message.content.length > remaining) break
      remaining -= message.content.length
      messages.unshift({ role: message.role as 'user' | 'assistant', content: message.content as string })
    }
    const agent = createDesignAgent(model, { profile, turnId: turn.turnId, sourceMessageId: turn.sourceMessageId, nowSec: Math.floor(Date.now() / 1000),
      repository: {
        read: () => store.get(turn.owner, turn.draftId),
        patch: (requestId, expectedRevision, patch) => store.patch(turn.owner, requestId, { draftId: turn.draftId, expectedRevision, patch }),
        restore: (requestId, expectedRevision, revision) => store.restore(turn.owner, requestId, { draftId: turn.draftId, expectedRevision, revision }),
        history: () => store.history(turn.owner, turn.draftId),
        compile: (requestId, expectedRevision) => artifacts.compile(turn.owner, requestId, { draftId: turn.draftId, expectedRevision }),
        compilations: () => artifacts.list(turn.owner, turn.draftId),
        ...(preparation.simulationEnabled ? { simulate: (requestId: string, expectedRevision: number, artifactId: string) =>
          simulations.start(turn.owner, requestId, { draftId: turn.draftId, expectedRevision, artifactId }) } : {}),
        simulations: () => simulations.list(turn.owner, turn.draftId),
      } })
    const result = await agent.stream({ messages, abortSignal: combined })
    let text = '', pending = '', lastFlush = Date.now()
    const flush = async () => {
      while (pending) {
        const part = pending.slice(0, 2000); pending = pending.slice(2000)
        await turns.appendEvent(turn, { kind: 'text', payload: { text: part } })
      }
      lastFlush = Date.now()
    }
    for await (const part of result.fullStream) {
      if (combined.aborted) throw new Error('agent-interrupted')
      if (part.type === 'error' || part.type === 'abort') throw new Error('model-unavailable')
      if (part.type === 'text-delta') {
        text += part.text; pending += part.text
        if (text.length > 16000) throw new Error('agent-output-budget')
        if (pending.length >= 1000 || Date.now() - lastFlush >= 300) await flush()
      }
      if (part.type === 'tool-result') {
        await flush()
        const output = part.output
        await turns.appendEvent(turn, { kind: 'tool', payload: { name: part.toolName,
          ok: !!output && typeof output === 'object' && 'ok' in output && output.ok === true } })
      }
    }
    if (combined.aborted || !text.trim()) throw new Error('agent-incomplete')
    await flush()
    await turns.finish(turn, { text })
    return { state: 'succeeded' as const }
  } catch {
    abort.abort()
    // A cancelled/superseded/reclaimed turn cannot publish an assistant message.
    if (!signal?.aborted) {
      try { await turns.finish(turn, { errorCode: 'agent-incomplete' }) } catch { /* authority lost */ }
    }
    return { state: 'incomplete' as const }
  } finally { clearInterval(heartbeat) }
}
