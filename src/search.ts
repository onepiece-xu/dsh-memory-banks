/**
 * Session-search helpers. Zero dependencies and no DSH imports, because the two
 * decisions here (when token recall is untrustworthy, and how to cut a snippet)
 * are exactly the parts worth unit-testing.
 *
 * Why a substring fallback exists: DSH's session index is FTS5 with the default
 * `unicode61` tokenizer, i.e. token recall, not substring recall. A one- or
 * two-character CJK query does not match a longer CJK token, so `auto` mode falls
 * back to the host's literal `{ kind: 'text' }` scan when token recall finds
 * nothing.
 */

/** Queries whose tokens are short enough that token recall may silently miss. */
export function isShortQuery(query: string): boolean {
  const words = query.split(/\s+/).filter((word) => word.length > 0)
  if (words.length === 0) return false
  return words.some((word) => Array.from(word).length < 3)
}

/** Whether `auto` mode should retry with the literal substring scan. */
export function shouldFallbackToSubstring(mode: string, query: string, tokenHits: number): boolean {
  if (tokenHits > 0) return false
  if (mode === 'tokens') return false
  if (mode === 'substring') return true
  return isShortQuery(query)
}

/**
 * Cut a snippet around the first match. Whitespace is flattened first so a
 * whitespace-flexible scan still shows a readable excerpt; a query that does not
 * appear verbatim (different whitespace) falls back to the head of the text.
 */
export function snippetAround(text: string, query: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  const needle = query.trim().toLowerCase()
  const haystack = flat.toLowerCase()
  let at = needle.length === 0 ? -1 : haystack.indexOf(needle)
  if (at === -1) {
    // Whitespace-flexible match: compare on the collapsed query.
    const collapsed = needle.replace(/\s+/g, ' ')
    at = collapsed.length === 0 ? -1 : haystack.indexOf(collapsed)
  }
  if (at === -1) return `${flat.slice(0, maxChars - 1)}…`
  const half = Math.floor(maxChars / 2)
  const start = Math.max(0, at - half)
  const end = Math.min(flat.length, start + maxChars)
  const slice = flat.slice(start, end)
  return `${start > 0 ? '…' : ''}${slice}${end < flat.length ? '…' : ''}`
}
