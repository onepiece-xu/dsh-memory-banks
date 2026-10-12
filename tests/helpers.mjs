// Shared test doubles. Map-backed tablets satisfy the storage-domain KV shape the
// repository programs against, so all repository/learning behaviour is testable
// without DSH installed.
import { MemoryRepository } from '../dist/repo.js'

export const NOW = '2026-10-12T00:00:00.000Z'

export class FakeTable {
  #map = new Map()
  get(key) { return this.#map.get(key) }
  entries() { return this.#map.entries() }
  keys() { return this.#map.keys() }
  async put(key, value) { this.#map.set(key, value) }
  async delete(key) { return this.#map.delete(key) }
  get size() { return this.#map.size }
}

export const DEFAULT_LIMITS = { memory: 60, user: 60, project: 60, failure: 120 }

export function makeRepo(overrides = {}) {
  const tables = {
    memories: new FakeTable(),
    standing: new FakeTable(),
    state: new FakeTable(),
    skills: new FakeTable(),
    reviews: new FakeTable(),
    consolidations: new FakeTable(),
  }
  const globalSlot = { value: { seq: 0 }, get() { return this.value }, async set(next) { this.value = next } }
  const repo = new MemoryRepository({
    ...tables,
    global: globalSlot,
    limits: DEFAULT_LIMITS,
    now: () => NOW,
    ...overrides,
  })
  return { repo, tables, globalSlot }
}

/** A `now` that advances, so repeated runs get distinct record ids. */
export function tickingNow(start = 0) {
  let tick = start
  return () => `2026-10-12T00:00:${String(tick++).padStart(2, '0')}.000Z`
}
