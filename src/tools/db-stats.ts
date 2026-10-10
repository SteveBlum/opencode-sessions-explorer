/**
 * Health/drift probe for opencode-sessions-explorer.
 *
 * Returns the cached SchemaState (migrations head, table counts, json1 status,
 * busy_timeout, hard_drift, drift_warnings). The state is computed once per
 * process and cached.
 */
import { tool } from "@opencode-ai/plugin"
import { getSchemaState } from "../lib/schema.js"
import { runWithEnvelope } from "../lib/envelope.js"

export const dbStats = tool({
  description:
    "opencode-sessions-explorer: health probe for the OpenCode SQLite database (~/.local/share/opencode/opencode.db). " +
    "Returns migration head, table counts (session/message/part — synthesized read-side from the OpenCode V2 tables session_v2/session_message; see src/lib/parts.ts), json1 extension status, busy_timeout, and any schema-drift warnings. " +
    "Run this when troubleshooting: any opencode-sessions-explorer-* tool returning SCHEMA_DRIFT, after an OpenCode upgrade, when verifying the DB is reachable, or when answering 'is opencode.db healthy / how many sessions are stored'.",
  args: {},
  async execute() {
    return runWithEnvelope("db_stats", 8, async () => {
      const s = getSchemaState()
      return {
        migrations_head: s.migrations_head,
        table_counts: s.table_counts,
        json1_ok: s.json1_ok,
        busy_timeout_ms: s.busy_timeout_ms,
        drift_warnings: s.drift_warnings,
        hard_drift: s.hard_drift,
        cached_at: s.cached_at,
      }
    })
  },
})
