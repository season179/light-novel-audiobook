import type { SpeechEngineContext, SpeechEngineFactory } from '@light-novel-audiobook/application'
import { QwenApplicationSpeechEngine } from './application-adapter.js'
import type { QwenTtsSpeechEngine } from './engine.js'
import type { SpeechRenderOptions } from './types.js'

/**
 * The composition-root seam for issue #45: turns a loaded `QwenTtsSpeechEngine` into the factory
 * `RenderAudiobook` calls **after** the book's approval catalog has been read back.
 *
 * The catalog reaches the adapter here and only here. There is no policy, flag or default that lets
 * a fallback segment through without a matching persisted decision — `QwenApplicationSpeechEngine`
 * refuses one, and this factory adds nothing that could soften that.
 *
 * `identity` is read from an adapter built with no catalog at all, which is exact rather than
 * approximate: the adapter deliberately excludes the catalog from its identity, so an engine built
 * with a hundred approvals hashes the same. `RenderAudiobook` asserts the two agree on every run, so
 * if that ever stopped being true it would fail loudly instead of re-rendering the book per click.
 *
 * The underlying engine is shared across calls on purpose: `endBatch()` is not terminal for this
 * adapter, and PLAN.md wants the TTS model to stay loaded between requests.
 */
export const createQwenSpeechEngineFactory = (
  engine: QwenTtsSpeechEngine,
  options: SpeechRenderOptions = {},
): SpeechEngineFactory => {
  const identity = new QwenApplicationSpeechEngine(engine, options).identity
  return Object.freeze({
    identity,
    create: (context: SpeechEngineContext) =>
      new QwenApplicationSpeechEngine(engine, {
        ...options,
        fallbackApprovals: context.fallbackApprovals,
      }),
  })
}
