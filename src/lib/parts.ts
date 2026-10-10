/**
 * Maps `session_message.content[]` (OpenCode V2's embedded-parts shape) to a
 * "one row per part" model, on every call, straight off `lib/db.ts#db()`.
 *
 * Two approaches:
 * 1. `PART_CTE` — a `WITH part AS (...)` SQL fragment that unnests `content[]`
 *    via `json_each`, exposing scalar columns (type/tool/status/text/input/
 *    output/error/hash/files/timestamps). Use for filter/group/aggregate
 *    queries (list-tool-failures, search-tool-calls, get-session,
 *    current-session, session-summary).
 * 2. `expandSessionMessage()` — unpacks one `session_message` row into a full
 *    `{message, parts}` pair. Use where the complete body is needed
 *    (get-message, get-part, session-timeline, the export pipeline).
 *
 * Part ids: `prt_<session_message_id>_<4-digit content index>`, zero-padded
 * so lexical ("id > ?") ordering matches creation order past 10 items in one
 * message (export.ts's incremental sync cursors rely on this).
 * `partIdToMessageId()` reverses it.
 */
import { db } from "./db.js"

export type RawSessionMessage = {
  id: string
  session_id: string
  type: string
  seq: number
  time_created: number
  time_updated: number
  data: string
}

export type MessageRow = { id: string; session_id: string; time_created: number; time_updated: number; data: string }
export type PartRow = { id: string; message_id: string; session_id: string; time_created: number; time_updated: number; data: string }

// ---------------------------------------------------------------------------
// Part-id synthesis
// ---------------------------------------------------------------------------

/** Deterministic, stable, `prt_`-prefixed synthetic part id (regex/filename compatible). */
export function makePartId(sessionMessageId: string, idx: number): string {
  const suffix = sessionMessageId.replace(/^msg_/, "")
  return `prt_${suffix}_${String(idx).padStart(4, "0")}`
}

/** Reverse of makePartId: recover the owning `session_message.id`. Returns null if malformed. */
export function partIdToMessageId(partId: string): string | null {
  const m = /^prt_(.+)_(\d{4,})$/.exec(partId)
  if (!m) return null
  return `msg_${m[1]}`
}

// ---------------------------------------------------------------------------
// Approach 1 — lean SQL CTE for scalar filter/group/aggregate queries.
// ---------------------------------------------------------------------------

/**
 * `WITH part AS (...)` — embed directly: `` `${PART_CTE} SELECT ... FROM part p WHERE ...` ``.
 * Columns: id, message_id, session_id, time_created, time_updated, type, tool,
 * status, text, input_json, input_filepath, output_text, error_text, hash,
 * files_json, t_start, t_end.
 */
export const PART_CTE = `
WITH part AS (
  SELECT
    sm.id || '_' || printf('%04d', c.key)                 AS id,
    sm.id                                                 AS message_id,
    sm.session_id                                         AS session_id,
    COALESCE(json_extract(c.value,'$.time.created'), json_extract(c.value,'$.time.ran'), sm.time_created) AS time_created,
    COALESCE(json_extract(c.value,'$.time.completed'), sm.time_updated) AS time_updated,
    json_extract(c.value,'$.type')                        AS type,
    json_extract(c.value,'$.name')                        AS tool,
    json_extract(c.value,'$.state.status')                AS status,
    json_extract(c.value,'$.text')                        AS text,
    json_extract(c.value,'$.state.input')                 AS input_json,
    json_extract(c.value,'$.state.input.filePath')        AS input_filepath,
    COALESCE(
      (SELECT group_concat(json_extract(t.value,'$.text'), char(10))
         FROM json_each(c.value,'$.state.content') t
        WHERE json_extract(t.value,'$.type')='text'),
      json_extract(c.value,'$.state.output')
    )                                                      AS output_text,
    COALESCE(json_extract(c.value,'$.state.error.message'), json_extract(c.value,'$.state.error')) AS error_text,
    json_extract(c.value,'$.hash')                        AS hash,
    json_extract(c.value,'$.files')                       AS files_json,
    COALESCE(json_extract(c.value,'$.time.created'), json_extract(c.value,'$.time.ran')) AS t_start,
    json_extract(c.value,'$.time.completed')              AS t_end
  FROM session_message sm, json_each(sm.data, '$.content') c
  WHERE sm.type = 'assistant'
  UNION ALL
  SELECT
    sm.id || '_0000', sm.id, sm.session_id, sm.time_created, sm.time_updated,
    CASE sm.type WHEN 'compaction' THEN 'compaction' ELSE 'text' END,
    NULL, NULL,
    CASE sm.type WHEN 'compaction' THEN json_extract(sm.data,'$.summary') ELSE json_extract(sm.data,'$.text') END,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM session_message sm WHERE sm.type != 'assistant'
)
`

// ---------------------------------------------------------------------------
// Approach 2 — full JS-level expansion into V1-shaped {message, parts}.
// ---------------------------------------------------------------------------

function flattenToolOutput(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const texts = content
    .filter((c): c is { type: string; text?: string } => !!c && typeof c === "object" && (c as any).type === "text")
    .map((c) => c.text ?? "")
  return texts.length ? texts.join("\n") : undefined
}

function errorToString(err: unknown): string | undefined {
  if (err == null) return undefined
  if (typeof err === "string") return err
  if (typeof err === "object") {
    const e = err as { message?: string; type?: string }
    return e.message ?? JSON.stringify(err)
  }
  return String(err)
}

/** Translate one V2 assistant `content[]` item into a V1-shaped `part.data` object. */
function transformContentItem(item: any): Record<string, unknown> {
  if (item?.type === "tool") {
    const state = item.state ?? {}
    return {
      type: "tool",
      tool: item.name,
      callID: item.id,
      state: {
        status: state.status,
        input: state.input,
        output: flattenToolOutput(state.content) ?? state.output,
        error: errorToString(state.error),
        metadata: state.metadata,
        time: item.time ? { start: item.time.created ?? item.time.ran, end: item.time.completed } : undefined,
      },
    }
  }
  // text / reasoning / step-start / step-finish / patch / file / … — field names already
  // match the V1 part shape, so pass through as-is.
  return { ...item }
}

export type Expanded = { message: MessageRow; parts: PartRow[] }

/** Unpack one `session_message` row into a V1-shaped `message` + its `part` rows. */
export function expandSessionMessage(row: RawSessionMessage): Expanded {
  let d: any
  try {
    d = JSON.parse(row.data)
  } catch {
    d = {}
  }
  const role = row.type === "user" ? "user" : row.type === "assistant" ? "assistant" : row.type
  const parts: PartRow[] = []

  const pushPart = (idx: number, data: Record<string, unknown>, ts?: { start?: number; end?: number }) => {
    parts.push({
      id: makePartId(row.id, idx),
      message_id: row.id,
      session_id: row.session_id,
      time_created: ts?.start ?? row.time_created,
      time_updated: ts?.end ?? ts?.start ?? row.time_updated,
      data: JSON.stringify(data),
    })
  }

  if (row.type === "assistant") {
    const content: any[] = Array.isArray(d.content) ? d.content : []
    content.forEach((item, idx) => {
      const t = item?.time
      pushPart(idx, transformContentItem(item), t ? { start: t.created ?? t.ran, end: t.completed } : undefined)
    })
  } else if (row.type === "user") {
    pushPart(0, { type: "text", text: d.text ?? "" }, { start: row.time_created })
    const files: any[] = Array.isArray(d.files) ? d.files : []
    files.forEach((f, i) => pushPart(i + 1, { type: "file", ...f }, { start: row.time_created }))
  } else if (row.type === "compaction") {
    pushPart(0, { type: "compaction", text: d.summary, status: d.status, reason: d.reason }, { start: row.time_created })
  } else {
    // system / synthetic / idle — single text-shaped part carrying whatever text we have.
    pushPart(0, { type: "text", text: d.text ?? JSON.stringify(d) }, { start: row.time_created })
  }

  const { content: _content, text: _text, files: _files, agents: _agents, ...messageRest } = d
  return {
    message: {
      id: row.id,
      session_id: row.session_id,
      time_created: row.time_created,
      time_updated: row.time_updated,
      data: JSON.stringify({ role, ...messageRest }),
    },
    parts,
  }
}

function fetchRawById(id: string): RawSessionMessage | null {
  return db().query(`SELECT * FROM session_message WHERE id = ?`).get(id) as RawSessionMessage | null
}

/** Fetch + expand ONE message by id. */
export function getMessageById(messageId: string): MessageRow | null {
  const row = fetchRawById(messageId)
  return row ? expandSessionMessage(row).message : null
}

/** Fetch + expand ONE part by id (parses the id to find its owning message). */
export function getPartById(partId: string): PartRow | null {
  const msgId = partIdToMessageId(partId)
  if (!msgId) return null
  const row = fetchRawById(msgId)
  if (!row) return null
  return expandSessionMessage(row).parts.find((p) => p.id === partId) ?? null
}

/** All messages for one session, expanded, time-ordered. */
export function getMessagesForSession(sessionId: string): MessageRow[] {
  const rows = db().query(`SELECT * FROM session_message WHERE session_id = ? ORDER BY time_created ASC, id ASC`).all(sessionId) as RawSessionMessage[]
  return rows.map((r) => expandSessionMessage(r).message)
}

/** All parts for one session, expanded, time-ordered (one session's worth — bounded, safe to fully expand). */
export function getPartsForSession(sessionId: string): PartRow[] {
  const rows = db().query(`SELECT * FROM session_message WHERE session_id = ? ORDER BY time_created ASC, id ASC`).all(sessionId) as RawSessionMessage[]
  return rows.flatMap((r) => expandSessionMessage(r).parts)
}

/** All parts for one message, expanded. */
export function getPartsForMessage(messageId: string): PartRow[] {
  const row = fetchRawById(messageId)
  return row ? expandSessionMessage(row).parts : []
}

/** Batch fetch + expand messages by id (search-text enrichment). Missing ids are simply absent from the result. */
export function getMessagesByIds(ids: string[]): Map<string, MessageRow> {
  const out = new Map<string, MessageRow>()
  const unique = Array.from(new Set(ids))
  if (unique.length === 0) return out
  const placeholders = unique.map(() => "?").join(",")
  const rows = db().query(`SELECT * FROM session_message WHERE id IN (${placeholders})`).all(...unique) as RawSessionMessage[]
  for (const r of rows) out.set(r.id, expandSessionMessage(r).message)
  return out
}

/** Batch fetch + expand parts by id (search-text enrichment). Resolves each id's owning message, fetches those in one query, then picks out the requested parts. */
export function getPartsByIds(ids: string[]): Map<string, PartRow> {
  const out = new Map<string, PartRow>()
  const wanted = new Set(ids)
  const msgIds = Array.from(new Set(ids.map(partIdToMessageId).filter((x): x is string => !!x)))
  if (msgIds.length === 0) return out
  const placeholders = msgIds.map(() => "?").join(",")
  const rows = db().query(`SELECT * FROM session_message WHERE id IN (${placeholders})`).all(...msgIds) as RawSessionMessage[]
  for (const r of rows) {
    for (const p of expandSessionMessage(r).parts) {
      if (wanted.has(p.id)) out.set(p.id, p)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Export-pipeline loaders — message-granularity cursors, flattened + role-tagged.
// ---------------------------------------------------------------------------

export type ExportPartRow = PartRow & { data_bytes: number; role: string | null }

function roleOf(type: string): string {
  return type === "user" ? "user" : type === "assistant" ? "assistant" : type
}

function toExportRows(row: RawSessionMessage): ExportPartRow[] {
  const role = roleOf(row.type)
  return expandSessionMessage(row).parts.map((p) => ({ ...p, data_bytes: Buffer.byteLength(p.data, "utf8"), role }))
}

/** One specific part, for the failed-parts retry path. */
export function loadPartById(partId: string): ExportPartRow | null {
  const msgId = partIdToMessageId(partId)
  if (!msgId) return null
  const row = fetchRawById(msgId)
  if (!row) return null
  return toExportRows(row).find((p) => p.id === partId) ?? null
}

/**
 * Part pagination for the insert fast path. Resolves `afterPartId` to its
 * owning message id and uses it as a `session_message.id > ?` cursor — a
 * whole message's parts are processed atomically. If `afterPartId` isn't a
 * well-formed part id (e.g. a sentinel cursor), it's used as the bound
 * verbatim so "cursor beyond all real ids" still no-ops the scan.
 */
export function loadPartRowsAfterId(afterPartId: string, limit: number): ExportPartRow[] {
  const afterMsgId = afterPartId ? (partIdToMessageId(afterPartId) ?? afterPartId) : null
  const rows = afterMsgId
    ? (db().query(`SELECT * FROM session_message WHERE id > ? ORDER BY id ASC LIMIT ?`).all(afterMsgId, limit) as RawSessionMessage[])
    : (db().query(`SELECT * FROM session_message ORDER BY id ASC LIMIT ?`).all(limit) as RawSessionMessage[])
  return rows.flatMap(toExportRows)
}

/** Same as `loadPartRowsAfterId` but scoped to one session (session-dirty rescan path). */
export function loadSessionPartRows(sessionId: string, afterPartId: string | null, limit: number): ExportPartRow[] {
  const afterMsgId = afterPartId ? (partIdToMessageId(afterPartId) ?? afterPartId) : null
  const rows = afterMsgId
    ? (db().query(`SELECT * FROM session_message WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?`).all(sessionId, afterMsgId, limit) as RawSessionMessage[])
    : (db().query(`SELECT * FROM session_message WHERE session_id = ? ORDER BY id ASC LIMIT ?`).all(sessionId, limit) as RawSessionMessage[])
  return rows.flatMap(toExportRows)
}

/** All searchable-type part ids for one session (tombstone reconciliation). */
export function getSearchablePartIdsForSession(sessionId: string, searchableTypes: readonly string[]): Set<string> {
  const types = new Set(searchableTypes)
  const ids = getPartsForSession(sessionId)
    .filter((p) => {
      try {
        return types.has(JSON.parse(p.data)?.type)
      } catch {
        return false
      }
    })
    .map((p) => p.id)
  return new Set(ids)
}
