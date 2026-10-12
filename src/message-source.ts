/**
 * The message-source vocabulary is a merge-extensible sum type: "each producer
 * declares its own `kind` in its own module; there is no shared catch-all
 * `plugin` kind" (`@deepseek-ai/dsh-llm` message.d.ts:96-100).
 *
 * Declaring our kind here is what makes `createUserMessage({ source: { kind:
 * 'dsh-memory-banks', form: 'recall' } })` type-check — and it is also what lets a
 * consumer recognize (and de-duplicate) memory-injected context later.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-memory-banks': {
      kind: 'dsh-memory-banks'
      /** `recall` = recalled memory / nudge; `instructions` = standing directives. */
      form?: 'recall' | 'instructions'
    }
  }
}

export {}
