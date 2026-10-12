/**
 * JSON extraction for model answers — zero dependencies, so the parsing that
 * every LLM-backed feature depends on is unit-testable on its own.
 *
 * Model answers arrive wrapped in prose or a ```json fence; both are normal, and
 * a silent mis-parse is worse than a loud failure, so each reader throws a
 * stable message instead of guessing.
 */

/**
 * Extract the first JSON object or array from a model answer: prefers a fenced
 * block, then falls back to brace/bracket scanning, then to the raw text.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new Error('model returned an empty answer')

  const candidates: string[] = []
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    if (typeof match[1] === 'string' && match[1].trim().length > 0) candidates.push(match[1].trim())
  }
  const start = trimmed.search(/[[{]/)
  if (start !== -1) {
    const opener = trimmed[start]
    const closer = opener === '{' ? '}' : ']'
    const end = trimmed.lastIndexOf(closer)
    if (end > start) candidates.push(trimmed.slice(start, end + 1))
  }
  candidates.push(trimmed)

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      // Try the next candidate shape.
    }
  }
  throw new Error('model answer contained no parseable JSON')
}

/** Read a JSON array of non-empty strings, capped and de-duplicated. */
export function readEntryList(value: unknown, limit: number): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as { entries?: unknown }).entries)
      ? ((value as { entries: unknown[] }).entries)
      : undefined
  if (raw === undefined) throw new Error('expected a JSON array of entries')
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text.length === 0 || seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= limit) break
  }
  if (out.length === 0) throw new Error('the answer contained no usable entries')
  return out
}
