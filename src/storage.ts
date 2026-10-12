/**
 * The storage-domain declaration for every table this plugin owns.
 *
 * Domain name doubles as the backend unit name, so data lands in
 * `$DSH_HOME/storages/dsh_plugin_memory.json` under the shipped `json` backend.
 * Record schemas live in `records.ts` (zod); the plugin's own `Config` stays
 * Schemastery. Table names must match `^[a-z][a-z0-9_]*$` (the storage unit-name
 * rule), which is why the session index table is `session_index`.
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

import {
  consolidationRecordSchema,
  memoryGlobalSchema,
  memoryRecordSchema,
  reviewRecordSchema,
  sessionIndexRecordSchema,
  skillRecordSchema,
  standingRecordSchema,
  stateRecordSchema,
} from './records.js'

export const memoryDomainSpec = defineDomain({
  name: 'dsh_plugin_memory',
  version: 1,
  global: { schema: memoryGlobalSchema, initial: { seq: 0 } },
  tables: {
    memories: domainTable(memoryRecordSchema),
    standing: domainTable(standingRecordSchema),
    state: domainTable(stateRecordSchema),
    reviews: domainTable(reviewRecordSchema),
    consolidations: domainTable(consolidationRecordSchema),
    skills: domainTable(skillRecordSchema),
    session_index: domainTable(sessionIndexRecordSchema),
  },
})
