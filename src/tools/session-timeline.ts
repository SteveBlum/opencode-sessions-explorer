/**
 * opencode-sessions-explorer-session-timeline
 *
 * Compact event list for one session — one event per part with a short
 * summary string. Use this to reconstruct what happened without pulling
 * raw bodies.
 *
 * Cursor: (part.time_created, part.id). Cap: 128 KB.
 */
import { tool } from "@opencode-ai/plugin"
import { stmt } from "../lib/db.js"
import { runWithEnvelope, fail } from "../lib/envelope.js"
import { decodePart } from "../lib/decode.js"
import { truncateString } from "../lib/truncate.js"
import { decodeCursor, encodeCursor } from "../lib/pagination.js"
import { table } from "../lib/table.js"
import { getPartsForSession } from "../lib/parts.js"

const ALL_TYPES = ["text", "tool", "reasoning", "file", "patch", "step-start", "step-finish", "compaction", "subtask"] as const
const DEFAULT_TYPES = ["text", "tool", "reasoning", "file", "patch", "subtask"] as const

export const sessionTimeline = tool({
  description:
    "opencode-sessions-explorer: chronological event stream for one OpenCode session. " +
    "Answers: \"walk me through session ses_X chronologically\", \"what happened in ses_Y step by step\", \"show me the events in session ses_Z in order\", \"play back session ses_W\", \"reconstruct the conversation flow of ses_X\", \"show me only the tool calls in ses_X\", \"only the patch events in ses_Y\". " +
    "Returns: events array (each = one part with type + short summary; NO raw bodies), sorted by time_created ascending. Each event has part_id, message_id, ts, type, data_bytes, and a one-line summary tuned per type (text snippet, [tool=X status=Y], [patch files=N], etc). " +
    "Filter by part types (any of text/tool/reasoning/file/patch/step-start/step-finish/compaction/subtask), and a time window via from_ts/until_ts. Cursor pagination via meta.next_cursor. " +
    "To expand a specific event use get-message (entire turn) or get-part (single part full body).",
  args: {
    session_id: tool.schema.string().describe("Session ID"),
    types: tool.schema.array(tool.schema.enum(ALL_TYPES)).optional().describe("Restrict to these part types"),
    granularity: tool.schema.enum(["events", "turns"]).default("events").describe("events returns one row per part; turns collapses adjacent parts by message_id"),
    from_ts: tool.schema.number().int().nonnegative().optional().describe("Only events with time_created >= from_ts"),
    until_ts: tool.schema.number().int().nonnegative().optional().describe("Only events with time_created <= until_ts"),
    limit: tool.schema.number().int().min(1).max(300).default(100).describe("Max events (1-300)"),
    cursor: tool.schema.string().optional(),
    max_summary_chars: tool.schema.number().int().min(40).max(2000).default(200),
  },
  async execute(args) {
    return runWithEnvelope("session_timeline", 128, async (ctx) => {
      // Confirm session exists
      const session = stmt(`SELECT id, time_archived FROM session_v2 WHERE id = ?`).get(args.session_id) as any
      if (!session) fail("NOT_FOUND", `session not found: ${args.session_id}`)

      const types = new Set(args.types && args.types.length > 0 ? args.types : [...DEFAULT_TYPES])
      const cursor = decodeCursor(args.cursor)

      let candidates = getPartsForSession(args.session_id)
        .map((p) => ({ ...p, decoded: decodePart(p.data) }))
        .filter((p) => types.has(p.decoded.type as any))
      if (args.from_ts !== undefined) candidates = candidates.filter((p) => p.time_created >= args.from_ts!)
      if (args.until_ts !== undefined) candidates = candidates.filter((p) => p.time_created <= args.until_ts!)
      if (cursor) candidates = candidates.filter((p) => p.time_created > cursor.ts || (p.time_created === cursor.ts && p.id > cursor.id))
      candidates.sort((a, b) => a.time_created - b.time_created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

      const limit = args.limit ?? 100
      let hasMore = false
      if (candidates.length > limit) {
        candidates = candidates.slice(0, limit)
        hasMore = true
      }
      if (hasMore && candidates.length > 0) {
        const last = candidates[candidates.length - 1]!
        ctx.nextCursor = encodeCursor({ ts: last.time_created, id: last.id })
      }
      const rawEvents = candidates.map((p) => ({
        part_id: p.id,
        message_id: p.message_id,
        ts: p.time_created,
        type: p.decoded.type,
        data_bytes: Buffer.byteLength(p.data, "utf8"),
        summary: summarize(p.decoded, args.max_summary_chars),
      }))
      const events = args.granularity === "turns" ? collapseTurns(rawEvents, args.max_summary_chars ?? 200) : rawEvents
      return {
        session_id: args.session_id,
        archived: session.time_archived != null,
        events: table(events, { dict: ["type", "message_id"] }),
        has_more: hasMore,
      }
    })
  },
})

function summarize(d: ReturnType<typeof decodePart>, maxChars: number): string {
  switch (d.type) {
    case "text":
      return truncateString(d.text.replace(/\s+/g, " "), maxChars).value
    case "reasoning":
      return "[reasoning] " + truncateString(d.text.replace(/\s+/g, " "), maxChars - 12).value
    case "tool":
      return `[tool=${d.tool} status=${d.status}${d.duration_ms != null ? ` ${d.duration_ms}ms` : ""}]` +
        (d.error ? " err:" + truncateString(d.error.replace(/\s+/g, " "), maxChars - 64).value : "")
    case "file":
      return `[file ${d.mime ?? "?"}] ${d.filename ?? d.url ?? "?"}`
    case "patch":
      return `[patch hash=${d.hash ?? "?"} files=${d.files.length}] ${d.files.slice(0, 5).join(", ")}${d.files.length > 5 ? ` +${d.files.length - 5}` : ""}`
    case "step-start":
      return `[step-start snapshot=${d.snapshot ?? "?"}]`
    case "step-finish":
      return `[step-finish reason=${d.reason ?? "?"}]`
    case "compaction":
      return `[compaction auto=${d.auto}]`
    case "subtask":
      return `[subtask agent=${d.agent ?? "?"}] ` + truncateString((d.description ?? d.prompt).replace(/\s+/g, " "), maxChars - 40).value
    default:
      return `[${d.type}]`
  }
}

function collapseTurns(events: any[], maxChars: number): any[] {
  const out: any[] = []
  for (const e of events) {
    const last = out[out.length - 1]
    if (last && last.message_id === e.message_id) {
      last.part_id = `${last.part_id},${e.part_id}`
      last.type = last.type === e.type ? last.type : "mixed"
      last.data_bytes += e.data_bytes
      last.summary = truncateString(`${last.summary} | ${e.summary}`, maxChars).value
    } else {
      out.push({ ...e })
    }
  }
  return out
}
