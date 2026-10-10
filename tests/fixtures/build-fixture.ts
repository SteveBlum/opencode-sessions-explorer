/**
 * Synthetic SQLite fixture builder for hermetic `bun test` runs.
 *
 * `buildFixtureDb(dbPath)` materializes a SMALL, deterministic opencode.db-shaped
 * database using bun:sqlite — on the OpenCode V2 schema (`session_v2` +
 * `session_message`; NO legacy `session`/`message`/`part` tables, matching a
 * fresh V2-only install). It creates the tables with ALL columns that
 * schema.ts hard-requires PLUS every extra column the tools SELECT, a
 * `__drizzle_migrations` table (one row), and a tiny dataset crafted so the
 * rehearsal probes pass WITHOUT touching the author's real ~/.local/share DB.
 *
 * The exported `FIXTURES` constant is the single source of truth for the IDs /
 * phrases / expected_counts shared between this generator and tests/helpers.ts.
 * Part ids are the SAME `prt_<session_message_id>_<content_index>` ids the
 * plugin's own read adapter (`src/lib/parts.ts`) synthesizes at read time
 * — see `partId()` below, which mirrors that scheme exactly.
 *
 * NOTE: this module has NO import-time side effects (it never opens a DB); only
 * calling buildFixtureDb() writes anything.
 */
import { Database } from "bun:sqlite"
import { join } from "node:path"

/** Mirrors parts.ts#makePartId — keep these in sync. */
function partId(sessionMessageId: string, idx: number): string {
  return `prt_${sessionMessageId.replace(/^msg_/, "")}_${String(idx).padStart(4, "0")}`
}

/**
 * Message ids embed a zero-padded GLOBAL sequence number (m0001, m0002, …) in
 * chronological insertion order. This matters: export.ts's incremental sync
 * paginates parts via lexical `p.id > ?` cursors (both per-session and
 * globally), and synthesized part ids are `prt_<message_id>_<idx>` — so the
 * message id itself must sort the same way its timestamp does. Real OpenCode
 * message ids are ULIDs (naturally time-sortable); these fixture ids fake
 * that property deliberately instead of using human-readable names.
 */
const MSG = {
  active_user: "msg_fix_m0001",
  active_asst: "msg_fix_m0002",
  a002_asst: "msg_fix_m0003",
  bigpart_user: "msg_fix_m0004",
  bigmsg_asst: "msg_fix_m0005",
  bigpart_patch_asst: "msg_fix_m0006",
} as const

/** Single source of truth for hermetic fixture identities. Mirrors fixtures.json shape. */
export const FIXTURES = {
  sessions: {
    active: "ses_fix_active001",
    archived: "ses_fix_archived01",
    deep_parent: "ses_fix_grand0001",
    big_part: "ses_fix_bigpart01",
    pre_migration: "ses_fix_premig001",
    missing: "ses_fix_missing_xyz",
  },
  messages: {
    active_first_user: MSG.active_user,
    big_message_150mb: MSG.bigmsg_asst,
    missing: "msg_fix_missing_xyz",
  },
  parts: {
    text_active: partId(MSG.active_user, 0),
    tool_completed: partId(MSG.active_asst, 0),
    tool_error: partId(MSG.active_asst, 1),
    big_5mb_patch: partId(MSG.bigpart_patch_asst, 220),
    tool_with_outputpath: partId(MSG.a002_asst, 0),
    missing: "prt_fix_missing_xyz",
  },
  phrases: {
    active_known: "Submit PR review",
  },
  expected_counts: {
    session_min: 5,
    message_min: 3,
    part_min: 50,
  },
} as const

const T = 1_775_000_000_000 // ~2026-04, satisfies "recent epoch" checks

const DIR_A = "/Users/iamironz/projects/opencode-sessions-explorer"
const DIR_B = "/Users/iamironz/projects/other-app"
const MODEL_A = JSON.stringify({ id: "claude-opus-4-8", providerID: "anthropic", variant: "max" })
const MODEL_B = JSON.stringify({ id: "gpt-5", providerID: "openai", variant: "high" })

type SessionSpec = {
  id: string
  title: string
  project_id?: string
  parent_id?: string | null
  directory?: string
  agent?: string
  model?: string
  cost?: number
  tokens_input?: number
  tokens_output?: number
  tokens_reasoning?: number
  time_archived?: number | null
  idx: number
}

/** Common message-level metadata (agent/model/cost/tokens) shared by every session_message row. */
const MSG_META = {
  agent: "build",
  model: { providerID: "anthropic", modelID: "claude-opus-4-8" },
  cost: 0.1,
  tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 5, write: 2 } },
}

export function buildFixtureDb(dbPath: string): void {
  const db = new Database(dbPath, { create: true })
  try {
    db.exec("PRAGMA journal_mode = WAL;")
    db.exec("PRAGMA foreign_keys = OFF;")

    db.exec(`
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        parent_id TEXT,
        workspace_id TEXT,
        slug TEXT,
        directory TEXT,
        path TEXT,
        title TEXT,
        version TEXT,
        share_url TEXT,
        cost REAL,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER,
        agent TEXT,
        model TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        time_compacting INTEGER,
        time_archived INTEGER
      );
    `)
    db.exec(`
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        type TEXT,
        seq INTEGER,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
    `)
    db.exec(`
      CREATE TABLE __drizzle_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT,
        created_at INTEGER
      );
    `)
    db.query("INSERT INTO __drizzle_migrations (id, name, created_at) VALUES (?, ?, ?)")
      .run(1, "0001_2026_05_initial_schema", T)

    const insSession = db.query(`
      INSERT INTO session_v2 (
        id, project_id, parent_id, workspace_id, slug, directory, path, title, version,
        share_url, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
        tokens_cache_write, agent, model, time_created, time_updated, time_compacting, time_archived
      ) VALUES (
        $id, $project_id, $parent_id, $workspace_id, $slug, $directory, $path, $title, $version,
        $share_url, $cost, $tokens_input, $tokens_output, $tokens_reasoning, $tokens_cache_read,
        $tokens_cache_write, $agent, $model, $time_created, $time_updated, $time_compacting, $time_archived
      )
    `)

    const addSession = (s: SessionSpec) => {
      const created = T + s.idx * 3_600_000
      const updated = created + 600_000
      const tokens_input = s.tokens_input ?? 1000
      insSession.run({
        $id: s.id,
        $project_id: s.project_id ?? "global",
        $parent_id: s.parent_id ?? null,
        $workspace_id: "wsp_fix_0001",
        $slug: s.id.replace(/^ses_/, "slug-"),
        $directory: s.directory ?? DIR_A,
        $path: s.directory ?? DIR_A,
        $title: s.title,
        $version: "2.0.26",
        $share_url: null,
        $cost: s.cost ?? 0.5,
        $tokens_input: tokens_input,
        $tokens_output: s.tokens_output ?? 500,
        $tokens_reasoning: s.tokens_reasoning ?? 100,
        $tokens_cache_read: 50,
        $tokens_cache_write: 20,
        $agent: s.agent ?? "build",
        $model: s.model ?? MODEL_A,
        $time_created: created,
        $time_updated: updated,
        $time_compacting: null,
        $time_archived: s.time_archived ?? null,
      })
    }

    // --- sessions ---------------------------------------------------------
    // Active session under test (title carries both "review" and "session").
    addSession({ id: FIXTURES.sessions.active, title: "Submit PR review for session explorer", cost: 2.5, idx: 1 })
    // Extra active sessions (>= 6 active so list_sessions limit:5 → has_more).
    addSession({ id: "ses_fix_active002", title: "Debugging the session timeline", cost: 1.2, idx: 2 })
    addSession({ id: "ses_fix_active003", title: "Refactor cost analysis", cost: 0.8, idx: 3 })
    addSession({ id: "ses_fix_active004", title: "Add new tool to plugin", cost: 0.3, idx: 4, directory: DIR_B, model: MODEL_B, agent: "plan" })
    addSession({ id: "ses_fix_active005", title: "Write tests for session codec", cost: 1.7, idx: 5 })
    addSession({ id: "ses_fix_active006", title: "Investigate slow query", cost: 0.4, idx: 6 })
    addSession({ id: "ses_fix_active007", title: "Plan session migration work", cost: 0.9, idx: 7, agent: "plan" })
    addSession({ id: "ses_fix_active008", title: "Tidy export tree", cost: 0.2, idx: 8 })
    addSession({ id: "ses_fix_active009", title: "Audit tool failures", cost: 0.6, idx: 9 })
    addSession({ id: "ses_fix_active010", title: "Review session cost report", cost: 1.1, idx: 10 })

    // Archived sessions (>= 1 archived).
    addSession({ id: FIXTURES.sessions.archived, title: "Old archived review session", cost: 0.7, idx: 11, time_archived: T + 11 * 3_600_000 + 100 })

    // Genealogy chain: root (archived) -> child -> grandchild.
    addSession({ id: "ses_fix_root00001", title: "Root orchestrator session", cost: 0.5, idx: 12, time_archived: T + 12 * 3_600_000 + 100 })
    addSession({ id: "ses_fix_child0001", title: "Child executor session", cost: 0.5, idx: 13, parent_id: "ses_fix_root00001" })
    addSession({ id: FIXTURES.sessions.deep_parent, title: "Grandchild session", cost: 0.5, idx: 14, parent_id: "ses_fix_child0001" })

    // Big-part session (many small patch parts).
    addSession({ id: FIXTURES.sessions.big_part, title: "Big patch session", cost: 0.5, idx: 15 })

    // Pre-migration zero-cost session.
    addSession({ id: FIXTURES.sessions.pre_migration, title: "Pre migration zero cost session", cost: 0, tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, idx: 16 })

    // --- session_message rows ----------------------------------------------
    // One row per logical message; assistant rows carry their parts inline as
    // a `content[]` array — this is the actual OpenCode V2 shape. The plugin's
    // own parts.ts unpacks these into message/part-shaped objects at read
    // time; FIXTURES.parts.* above already matches the ids it will produce.
    let seq = 0
    const insMsg = db.query(`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    const addUserMessage = (id: string, sessionId: string, ts: number, text: string, files: unknown[] = []) =>
      insMsg.run(id, sessionId, "user", ++seq, ts, ts, JSON.stringify({ ...MSG_META, role: "user", time: { created: ts }, text, files, agents: [] }))
    const addAssistantMessage = (id: string, sessionId: string, ts: number, content: unknown[]) =>
      insMsg.run(id, sessionId, "assistant", ++seq, ts, ts, JSON.stringify({ ...MSG_META, role: "assistant", time: { created: ts }, content }))

    const textItem = (text: string, ts: number) => ({ type: "text", text, time: { created: ts, completed: ts } })
    const reasoningItem = (text: string, ts: number) => ({ type: "reasoning", text, time: { created: ts, completed: ts } })
    const patchItem = (hash: string, files: string[], ts: number) => ({ type: "patch", hash, files, time: { created: ts, completed: ts } })
    const toolItem = (opts: { name: string; callID: string; status: string; input: unknown; output?: string; error?: string; metadata?: unknown; tsStart: number; tsEnd?: number }) => ({
      type: "tool",
      id: opts.callID,
      name: opts.name,
      executed: false,
      state: {
        status: opts.status,
        input: opts.input,
        output: opts.output,
        error: opts.error ? { type: "unknown", message: opts.error } : undefined,
        metadata: opts.metadata ?? {},
      },
      time: { created: opts.tsStart, ran: opts.tsStart, completed: opts.tsEnd ?? opts.tsStart },
    })

    // Active session content.
    addUserMessage(
      MSG.active_user,
      FIXTURES.sessions.active,
      T + 10,
      "Submit PR review for the session explorer. Please double-check the regex handling.",
    )
    addAssistantMessage(MSG.active_asst, FIXTURES.sessions.active, T + 20, [
      toolItem({ name: "bash", callID: "call_fix_done", status: "completed", input: { command: "ls -la" }, output: "ok done", tsStart: T + 21, tsEnd: T + 24 }),
      toolItem({ name: "read", callID: "call_fix_err", status: "error", input: { filePath: "/x/missing.ts" }, error: "read failed: file not found", tsStart: T + 22 }),
      reasoningItem("Considering the PR review feedback before applying changes.", T + 23),
    ])

    // active002 — externalized-output tool part + a second error (for failure grouping).
    const T2 = T + 2 * 3_600_000
    const toolOutDir = process.env.OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR ?? "/tmp/opencode-tool-output"
    addAssistantMessage(MSG.a002_asst, "ses_fix_active002", T2 + 20, [
      toolItem({
        name: "grep",
        callID: "call_fix_op",
        status: "completed",
        input: { pattern: "foo" },
        // Whitelisted path (inside the tool-output dir) but intentionally NOT created on
        // disk, so dereference fails gracefully (null + warning) — see rehearsal CC-03c.
        metadata: { outputPath: join(toolOutDir, "tool_fix_outpath01") },
        tsStart: T2 + 21,
      }),
      toolItem({ name: "edit", callID: "call_fix_err2", status: "error", input: { filePath: "/x/edit.ts" }, error: "edit failed: pattern not found", tsStart: T2 + 22 }),
    ])

    // Big-part session content.
    const TB = T + 15 * 3_600_000
    addUserMessage(MSG.bigpart_user, FIXTURES.sessions.big_part, TB + 10, "work on the big patch please")
    addAssistantMessage(MSG.bigmsg_asst, FIXTURES.sessions.big_part, TB + 20, [
      patchItem("hbig1", ["src/a.ts", "src/b.ts"], TB + 21),
      textItem("applied the patch", TB + 22),
    ])
    // ~220 small patch parts + 1 oversized-by-count patch (>200 files triggers
    // get-part files truncation, and the raw JSON is several KB).
    const smallPatches = Array.from({ length: 220 }, (_, i) => patchItem(`h${i}`, [`src/gen/file_${i}.ts`], TB + 40 + i))
    const bigFiles = Array.from({ length: 260 }, (_, i) => `src/module/generated/file_${String(i).padStart(4, "0")}.ts`)
    addAssistantMessage(MSG.bigpart_patch_asst, FIXTURES.sessions.big_part, TB + 30, [
      ...smallPatches,
      patchItem("hbigpatch", bigFiles, TB + 1000),
    ])

    db.exec("PRAGMA wal_checkpoint(TRUNCATE);")
  } finally {
    db.close()
  }
}
