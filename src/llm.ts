/**
 * The one-shot model call used by background review and consolidation.
 *
 * DSH's `ctx.llm` has no non-streaming entry point (`GenerateOptions` is consumed
 * by `stream()`), so a one-shot caller drives the stream through `BlockAssembler`
 * and joins the text blocks — the same shape `dsh-session-title-llm` uses. This
 * file is deliberately the ONLY DSH-typed part of the learning loop: `learning.ts`
 * receives the result as an injected `oneShot` function and stays testable.
 *
 * Cost note: this is an independent request series, so it never disturbs the
 * running session's prompt prefix cache (and never benefits from it either).
 */
import { BlockAssembler, createUserMessage, type RequestMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** Structural view of `ctx.llm`: only `stream` is used. */
export interface LlmRuntimeLike {
  stream(options: {
    provider: string
    model: string
    messages: RequestMessage[]
    system?: string
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<StreamChunk>
}

export interface LlmRoute {
  provider: string
  model: string
}

/** Explicit config wins; otherwise the deployment's default model selection. */
export function resolveRoute(options: { provider?: string; model?: string; fallback?: LlmRoute }): LlmRoute | undefined {
  if (options.provider !== undefined && options.provider.length > 0 && options.model !== undefined && options.model.length > 0) {
    return { provider: options.provider, model: options.model }
  }
  return options.fallback
}

export interface OneShotRequest {
  system: string
  user: string
  maxTokens: number
  timeoutMs: number
  /** The session this call belongs to; the host attributes routing/accounting to it. */
  sessionId?: string
}

/** Build the callable the learning loop injects; `route` is re-read per call. */
export function createOneShot(
  llm: LlmRuntimeLike,
  route: () => LlmRoute | undefined,
): (request: OneShotRequest) => Promise<string> {
  return async (request) => {
    const resolved = route()
    if (resolved === undefined) throw new Error('no model route available for the memory review call')

    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error(`memory model call timed out after ${request.timeoutMs}ms`)),
      request.timeoutMs,
    )
    try {
      const assembler = new BlockAssembler()
      const message = createUserMessage({
        content: [{ type: 'text', text: request.user }],
        source: { kind: 'dsh-plugin-memory', form: 'recall' },
      })
      for await (const chunk of llm.stream({
        provider: resolved.provider,
        model: resolved.model,
        messages: [message as unknown as RequestMessage],
        system: request.system,
        maxTokens: request.maxTokens,
        signal: controller.signal,
        // The one working one-shot precedent (`dsh-session-title-llm`) always
        // passes the owning session id; omitting it made the provider abort.
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId as never }),
      })) {
        assembler.push(chunk)
      }
      const finish = assembler.finish
      if (finish !== undefined && finish.kind !== 'stop' && finish.kind !== 'max-tokens') {
        const failure = (finish as { failure?: { message?: string; code?: string } }).failure
        throw new Error(`memory model call failed: ${failure?.code ?? finish.kind}${failure?.message === undefined ? '' : ` — ${failure.message}`}`)
      }
      const text = assembler
        .blocks()
        .filter((block) => block.type === 'text')
        .map((block) => (block as { text: string }).text)
        .join('\n')
        .trim()
      if (text.length === 0) throw new Error('the memory model call returned no text')
      return text
    } finally {
      clearTimeout(timer)
    }
  }
}
