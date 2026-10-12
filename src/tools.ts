/**
 * The six model-facing tools, named and shaped exactly like pi-hermes-memory's:
 * `memory_add` / `memory_replace` / `memory_remove` / `memory_search` /
 * `session_search` / `skill_manage`.
 *
 * These bodies stay thin on purpose: every rule lives in `repo.ts` / `core.ts` /
 * `templates.ts`, which are dependency-free and unit-tested. Here we only map
 * model arguments onto those calls and render the result.
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { BANKS, CATEGORIES, type Bank, type Category, type SkillRecord } from './records.js'
import type { MemoryRepository } from './repo.js'
import {
  assertSkillDescription,
  assertSkillName,
  renderSkillBody,
  patchSkillSection,
  skillSlug,
  type SkillAction,
} from './templates.js'

/** One hit from the DSH session-history index (`ctx.sessionQuery`). */
export interface SessionHit {
  sessionId: string
  cwd?: string
  snippet: string
}

export interface ToolDeps {
  /** Resolves once the storage domain is open (tool bodies never run before it). */
  repo: () => Promise<MemoryRepository>
  config: {
    searchLimit: number
    sessionSearchLimit: number
    maxSnippetChars: number
    usageHitTrackingEnabled: boolean
  }
  /** Active project key (workspace directory), for two-tier memory. */
  projectKey: () => string | undefined
  /** Injected by the host half when `ctx.sessionQuery` is available. */
  sessionSearch?: (query: string, options: { limit: number; snippetChars: number; role?: 'user' | 'assistant' }) => Promise<SessionHit[]>
  /** Mirror a stored skill into the host's native skill registry. */
  skillSync?: (record: SkillRecord) => Promise<void>
  skillUnsync?: (id: string) => Promise<void>
  /**
   * Called when a write is refused for exceeding a bank's budget, before the
   * write is retried once. The host wires this to auto-consolidation.
   */
  onOverflow?: (bank: Bank) => Promise<void>
}

const text = (value: string) => [{ type: 'text' as const, text: value }]

function optionalProject(deps: ToolDeps, requested?: string): string | undefined {
  return requested ?? deps.projectKey()
}

function resolveBank(target: unknown, fallback: Bank = 'memory'): Bank {
  return (typeof target === 'string' ? (target as Bank) : fallback) ?? fallback
}

export function createMemoryTools(deps: ToolDeps): ToolDefinition[] {
  const { config } = deps

  const memoryAdd = defineTool({
    name: 'memory_add',
    description: 'Save one durable memory entry that should survive across sessions. Banks: memory (how this environment works), user (who the user is and prefers), project (this repository), failure (what did not work and why).',
    parameters: {
      target: { type: 'string', required: true, enum: [...BANKS], description: 'Which bank to write to.' },
      content: { type: 'string', required: true, description: 'The entry itself: one short, factual statement.' },
      category: { type: 'string', enum: [...CATEGORIES], description: 'Optional category, mainly for failure entries.' },
      failure_reason: { type: 'string', description: 'For target=failure: why it did not work (appended to the entry).' },
      project: { type: 'string', description: 'Project key override for the project bank (defaults to the active workspace).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          bank: { type: 'string', required: true },
          usage: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(`Saved to the ${value.bank} bank ${value.usage}`),
    },
    async execute(args) {
      const repo = await deps.repo()
      const bank = resolveBank(args.target)
      const content = args.failure_reason === undefined
        ? args.content
        : `${args.content} [reason: ${args.failure_reason}]`
      const write = () => repo.add({
        target: bank,
        content,
        category: args.category as Category | undefined,
        project: bank === 'project' ? optionalProject(deps, args.project) : args.project,
        source: 'tool',
      })
      let result
      try {
        result = await write()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // A refused over-budget write gets one consolidation attempt, then one retry.
        if (deps.onOverflow === undefined || !/over budget/.test(message)) throw error
        await deps.onOverflow(bank)
        result = await write()
      }
      return { ok: true, id: result.record.id, bank, usage: result.usage }
    },
  })

  const memoryReplace = defineTool({
    name: 'memory_replace',
    description: 'Update an existing memory entry in place. `old_text` identifies it: an exact match wins, otherwise it must match exactly one entry.',
    parameters: {
      target: { type: 'string', required: true, enum: [...BANKS], description: 'Bank holding the entry.' },
      old_text: { type: 'string', required: true, description: 'Text identifying the entry to replace.' },
      content: { type: 'string', required: true, description: 'The replacement entry.' },
      category: { type: 'string', enum: [...CATEGORIES], description: 'Optional new category.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          bank: { type: 'string', required: true },
          usage: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(`Updated the ${value.bank} bank ${value.usage}`),
    },
    async execute(args) {
      const repo = await deps.repo()
      const bank = resolveBank(args.target)
      const result = await repo.replace({
        target: bank,
        oldText: args.old_text,
        content: args.content,
        category: args.category as Category | undefined,
        project: bank === 'project' ? optionalProject(deps) : undefined,
      })
      return { ok: true, id: result.record.id, bank, usage: result.usage }
    },
  })

  const memoryRemove = defineTool({
    name: 'memory_remove',
    description: 'Delete one memory entry that became wrong. `old_text` must identify exactly one entry.',
    parameters: {
      target: { type: 'string', required: true, enum: [...BANKS], description: 'Bank holding the entry.' },
      old_text: { type: 'string', required: true, description: 'Text identifying the entry to delete.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          bank: { type: 'string', required: true },
          usage: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(`Removed from the ${value.bank} bank ${value.usage}`),
    },
    async execute(args) {
      const repo = await deps.repo()
      const bank = resolveBank(args.target)
      const result = await repo.remove({ target: bank, oldText: args.old_text })
      return { ok: true, id: result.removed.id, bank, usage: result.usage }
    },
  })

  const memorySearch = defineTool({
    name: 'memory_search',
    description: 'Search the durable memory banks by keyword: every word in the query must appear in an entry.',
    parameters: {
      query: { type: 'string', required: true, description: 'Keywords; all words must match.' },
      project: { type: 'string', description: 'Restrict to one project key.' },
      target: { type: 'string', enum: [...BANKS], description: 'Restrict to one bank.' },
      category: { type: 'string', enum: [...CATEGORIES], description: 'Restrict to one category.' },
      limit: { type: 'integer', description: 'Maximum hits (default from plugin config).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                bank: { type: 'string', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => text(value.count === 0
        ? 'No memory matched that query.'
        : value.hits.map((hit) => `[${hit.bank}] ${hit.text}`).join('\n')),
    },
    async execute(args) {
      const repo = await deps.repo()
      const hits = repo.find(args.query, {
        banks: args.target === undefined ? undefined : [resolveBank(args.target)],
        category: args.category as Category | undefined,
        project: optionalProject(deps, args.project),
        limit: args.limit ?? config.searchLimit,
      })
      if (config.usageHitTrackingEnabled && hits.length > 0) await repo.noteHits(hits)
      return {
        count: hits.length,
        hits: hits.map((hit) => ({ id: hit.id, bank: hit.bank, text: hit.text })),
      }
    },
  })

  const sessionSearch = defineTool({
    name: 'session_search',
    description: 'Search past conversations (DSH session history) for a keyword or phrase. Use it to recall what was discussed or decided earlier, then save what matters with memory_add.',
    parameters: {
      query: { type: 'string', required: true, description: 'Keywords or an exact phrase in double quotes.' },
      role: { type: 'string', enum: ['user', 'assistant'], description: 'Restrict to the user or the assistant side.' },
      limit: { type: 'integer', description: 'Maximum sessions to return (1..20).' },
      snippet_chars: { type: 'integer', description: 'Excerpt size per hit (100..4000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                session_id: { type: 'string', required: true },
                cwd: { type: 'string', required: true },
                snippet: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => text(value.count === 0
        ? 'No past conversation matched that query.'
        : value.hits.map((hit) => `[${hit.cwd || hit.session_id}] ${hit.snippet}`).join('\n\n')),
    },
    async execute(args) {
      if (deps.sessionSearch === undefined) {
        throw new Error('session search is unavailable in this profile (the host serves no session-query service)')
      }
      const limit = Math.min(Math.max(args.limit ?? config.sessionSearchLimit, 1), 20)
      const snippetChars = Math.min(Math.max(args.snippet_chars ?? config.maxSnippetChars, 100), 4000)
      const hits = await deps.sessionSearch(args.query, {
        limit,
        snippetChars,
        role: args.role as 'user' | 'assistant' | undefined,
      })
      return {
        count: hits.length,
        hits: hits.map((hit) => ({ session_id: hit.sessionId, cwd: hit.cwd ?? '', snippet: hit.snippet })),
      }
    },
  })

  const skillManage = defineTool({
    name: 'skill_manage',
    description: 'Save and curate reusable procedures ("how to do X here"), global or project scoped. Use action create to save one, view to read, patch to fix one section, update to rewrite, delete to drop it.',
    parameters: {
      action: { type: 'string', required: true, enum: ['create', 'view', 'patch', 'update', 'delete'], description: 'What to do.' },
      scope: { type: 'string', enum: ['global', 'project'], description: 'Required for create: global or this project.' },
      name: { type: 'string', description: 'Skill name (kebab-case is derived).' },
      description: { type: 'string', description: 'One line stating when to use it — include the trigger phrasings.' },
      skill_id: { type: 'string', description: 'Existing skill id for view/patch/update/delete.' },
      section: { type: 'string', description: 'For patch: the section heading to replace (e.g. "Pitfalls").' },
      when_to_use: { type: 'string', description: 'For create/update: the "When to Use" section.' },
      steps: { type: 'array', items: { type: 'string' }, description: 'For create/update: the procedure steps.' },
      pitfalls: { type: 'array', items: { type: 'string' }, description: 'For create/update: known pitfalls.' },
      verification: { type: 'array', items: { type: 'string' }, description: 'For create/update: how to verify it worked.' },
      content: { type: 'string', description: 'For create/update: raw body, or the new text when patching.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          id: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const repo = await deps.repo()
      const action = args.action as SkillAction
      const project = optionalProject(deps)
      const skills = repo.skills(undefined, project)
      const findById = (id: string | undefined): SkillRecord => {
        const record = id === undefined ? undefined : repo.skill(id)
        if (record === undefined) throw new Error(`no skill with id ${JSON.stringify(id ?? '')} (use action "view" to list them)`)
        return record
      }

      if (action === 'view') {
        if (args.skill_id === undefined) {
          const list = skills.length === 0
            ? 'No skills stored yet.'
            : skills.map((skill) => `- ${skill.id} [${skill.scope}] ${skill.name}: ${skill.description}`).join('\n')
          return { ok: true, action, id: '', message: list }
        }
        const skill = findById(args.skill_id)
        return { ok: true, action, id: skill.id, message: `${skill.name} [${skill.scope}]\n${skill.description}\n\n${skill.body}` }
      }

      if (action === 'delete') {
        const skill = findById(args.skill_id)
        await repo.skillDelete(skill.id)
        await deps.skillUnsync?.(skill.id)
        return { ok: true, action, id: skill.id, message: `Deleted skill ${skill.name}.` }
      }

      if (action === 'patch') {
        const skill = findById(args.skill_id)
        if (args.section === undefined || args.content === undefined) {
          throw new Error('skill_manage patch requires section and content')
        }
        const body = patchSkillSection(skill.body, args.section, args.content)
        const next: SkillRecord = { ...skill, body, updatedAt: new Date().toISOString() }
        await repo.skillPut(next)
        await deps.skillSync?.(next)
        return { ok: true, action, id: next.id, message: `Patched "${args.section}" in skill ${next.name}.` }
      }

      if (action === 'create') {
        const name = assertSkillName(args.name ?? '')
        const description = assertSkillDescription(args.description ?? '')
        const scope = args.scope
        if (scope === undefined) throw new Error('skill_manage create requires scope (global or project)')
        if (scope === 'project' && project === undefined) {
          throw new Error('a project-scoped skill needs an active workspace; use scope "global" instead')
        }
        const id = skillSlug(name)
        if (repo.skill(id) !== undefined) throw new Error(`skill ${id} already exists — use action update or patch`)
        if (skills.some((skill) => skill.name.toLowerCase() === name.toLowerCase())) {
          throw new Error(`a skill named ${name} already exists — use action update or patch`)
        }
        const now = new Date().toISOString()
        const record: SkillRecord = {
          id,
          scope,
          name,
          description,
          body: renderSkillBody({
            whenToUse: args.when_to_use,
            steps: args.steps,
            pitfalls: args.pitfalls,
            verification: args.verification,
            content: args.content,
          }),
          createdAt: now,
          updatedAt: now,
        }
        if (scope === 'project' && project !== undefined) record.project = project
        await repo.skillPut(record)
        await deps.skillSync?.(record)
        return { ok: true, action, id, message: `Created ${scope} skill ${name} (${id}).` }
      }

      const skill = findById(args.skill_id)
      const description = args.description === undefined ? skill.description : assertSkillDescription(args.description)
      const body = args.content !== undefined || args.steps !== undefined || args.when_to_use !== undefined
        ? renderSkillBody({
          whenToUse: args.when_to_use,
          steps: args.steps,
          pitfalls: args.pitfalls,
          verification: args.verification,
          content: args.content,
        })
        : skill.body
      const next: SkillRecord = { ...skill, description, body, updatedAt: new Date().toISOString() }
      await repo.skillPut(next)
      await deps.skillSync?.(next)
      return { ok: true, action, id: next.id, message: `Updated skill ${next.name}.` }
    },
  })

  return [memoryAdd, memoryReplace, memoryRemove, memorySearch, sessionSearch, skillManage]
}
