# AGENTS.md

`opencode-sessions-explorer` is an **OpenCode plugin** that exposes the local OpenCode
SQLite DB (`~/.local/share/opencode/opencode.db`) to the LLM as 18 tools — 17 read-only
(recall, search, cost/usage analysis) plus one deliberate write (`unarchive-session`).
Runtime is **Bun** (it uses `bun:sqlite`), not Node. `README.md` has the full tool
catalog; `CHANGELOG.md` tracks status.

## Commands

| Task                 | Command                                  |
| -------------------- | ---------------------------------------- |
| Install              | `bun install`                            |
| Typecheck            | `bun run typecheck` (`tsc --noEmit`)     |
| Test (full suite)    | `bun test`                               |
| Single test file     | `bun test tests/codec.test.ts`           |
| Build to `dist/`     | `bun run build`                          |
| E2E verify vs SQL    | `bun tests/verify-end-to-end.ts`         |
| Install health probe | `bun src/bin/check-deps.ts`              |

CI runs in GitHub Actions: `.github/workflows/ci.yml` runs typecheck, build, the
hermetic test suite, the end-to-end verify, and `pack:dry` on ubuntu + macos;
`publish.yml` publishes to npm on `v*` tags; `labels.yml` syncs issue labels.

## Required workflow before declaring work done

1. `bun run typecheck` must pass (strict mode; `.d.ts` emit is intentionally off — see
   gotchas).
2. `bun test` — but read the **Tests** caveat below before trusting any failure.
3. For changes to tool output, run `bun tests/verify-end-to-end.ts` (compares each tool
   against ground-truth SQL).
4. If you touched anything user-facing, update `README.md` and `CHANGELOG.md`
   (`[Unreleased]`).

## Critical gotchas (verified; easy to get wrong)

- **Imports in `src/` always use `.js`, never `.ts`.** Sibling imports reference the
  compiled path, e.g. `import { stmt } from "../lib/db.js"` — even though the file is
  `db.ts`. Required by `tsc` (`moduleResolution: bundler`) and `bun build`. (Files under
  `tests/` import `src` with `.ts`; that is fine because bun runs them unbuilt.)
- **Tests run against a hermetic synthetic fixture by default.** `tests/fixtures/build-fixture.ts`
  materializes a small, deterministic V2-shaped DB (`session_v2` + `session_message`) in a
  temp dir; `tests/setup.ts` (a Bun preload) points every `OPENCODE_SESSIONS_EXPLORER_*` path
  at it before any test imports `src`. Set `OPENCODE_SESSIONS_EXPLORER_LIVE=1` to opt OUT and
  run against your real `~/.local/share/opencode/opencode.db` instead (`bun run test:live`) —
  in that mode `tests/fixtures.json` (hardcoded real ids/counts from the author's machine)
  is used, and failures there are NOT portable/reliable (do not treat them as regressions).
- **`src/plugin.ts` only supports the OpenCode V2 host.** The default export is a plain
  `{ id, setup }` definition object; `setup(ctx)` registers tools via
  `ctx.tool.transform(editor => registerTools(editor, tools, ctx.location))`
  (`src/lib/tool-registration.ts`). There is no V1 entrypoint and no `server()` method.
- **The shared `lib/db.js` handle is read-only — never write through it.** It opens
  `readonly: true` + `PRAGMA query_only = 1`, so any write on that path throws. The ONE
  sanctioned write surface is `lib/db-write.js` (used only by `unarchive-session`), which
  opens a SEPARATE, short-lived `readwrite: true` connection for a single
  `UPDATE session_v2 SET time_archived = NULL, time_updated = <now>` and closes it
  immediately. The `time_updated` bump is REQUIRED, not cosmetic: OpenCode loads sessions
  ordered by `time_updated DESC` with a default `LIMIT 100` per directory, so clearing only
  `time_archived` leaves a long-archived session buried below that window and the app fails
  to retrieve it ("Unable to retrieve session"). Do not add other writers, and do not route
  writes through the shared read handle. (OpenCode exposes no HTTP/SDK endpoint that can
  CLEAR the archived flag — `UpdatePayload.time.archived` is a finite number and the handler
  ignores `undefined` — so the direct DB write is the only mechanism. See
  `src/tools/unarchive-session.ts`.)
- **`.d.ts` declaration emit is disabled** (`tsconfig` `declaration: false`) because
  `tool({…})` leaks zod internals. Do not enable it without adding explicit
  `: ToolDefinition` annotations per tool.
- **OpenCode V2 schema (`session_v2` + `session_message`), not V1 (`session`/`message`/
  `part`).** `session_message` merges what used to be `message` + `part` into one row per
  logical message: `type` ('user'/'assistant'/'system'/'compaction'/'synthetic'/'idle')
  plus a `data` JSON blob; assistant rows carry their parts inline as `content[]`. Every
  tool queries `session_v2`/`session_message` directly. `lib/parts.ts` provides two ways
  to deal with `content[]`:
  1. `PART_CTE` — a `WITH part AS (...)` SQL fragment unnesting `content[]` via
     `json_each`, exposing scalar columns (`type`/`tool`/`status`/`text`/`input_json`/
     `input_filepath`/`output_text`/`error_text`/`hash`/`files_json`/`t_start`/`t_end`).
     Use for filter/group/aggregate queries (list-tool-failures, search-tool-calls,
     get-session, current-session, session-summary).
  2. `expandSessionMessage()` — unpacks one `session_message` row into a full
     `{message, parts}` pair (parts get a synthesized, lexically-sortable
     `prt_<message_id>_<4-digit content index>` id; `partIdToMessageId()` reverses it).
     Use where the complete body is needed: get-message, get-part, session-timeline, the
     export pipeline (via `getMessageById`/`getPartById`/`getPartsForSession`/
     `loadPartRowsAfterId`).
  Never unnest `session_message.content[]` ad hoc in a tool file — go through one of these.

## Architecture (4 layers)

```
SQLite DB (read-only source of truth; OpenCode V2 schema — session_v2 + session_message)
  -> lib/parts.ts (PART_CTE for aggregate SQL, expandSessionMessage() for full bodies)
  -> filesystem export tree (~/.local/share/opencode-sessions-explorer; by-session + by-channel)
  -> ck regex scan (stateless; optional)
  -> enriched response (re-fetches session/part metadata from SQLite per hit)
```

`search-text` and `grep-session` shell out to the optional **`ck` CLI**. If `ck` is
absent they must return `CK_NOT_FOUND` cleanly — the other 16 tools work without it. The
export tree is materialized by `bin/bulk-export.ts`; the plugin auto-syncs new parts
before each search call.

## Adding or editing a tool

- One tool per file in `src/tools/`, exported as a **named const** (not default).
  Register it in `src/tools/index.ts` under the `opencode-sessions-explorer-<name>` key
  **and** the re-export block.
- Wrap the body in `runWithEnvelope("<fn_name>", capKb, async (ctx) => { … })`
  (`lib/envelope.js`). This builds the `{ ok, data, meta, warnings }` envelope, runs
  schema-drift detection, and sizes the payload against `capKb`.
- Raise recoverable errors via `fail(code, msg, hint)` or
  `throw new SessionsError(code, msg, hint)` using a code from `lib/errors.ts`
  (`NOT_FOUND`, `BAD_ARGS`, `CK_NOT_FOUND`, …). Do not invent ad-hoc error shapes.
- Query the DB through `stmt(sql).all/get(...)` (`lib/db.js`): `session_v2` directly;
  part-level data via `lib/parts.ts` (`PART_CTE` or `expandSessionMessage`/`getPartById`/
  etc.) — see the V2 schema gotcha above.
- **List-shaped results must be wrapped in `table(records, { dict: [...] })`**
  (`lib/table.ts`) — lossless columnar + interning format. Reference decoder is
  `decodeTable()`.
- Tool `description`s are long natural-language strings containing `Answers: "..."`
  example phrasings; that text is how the LLM routes to the tool. Match the existing style.

## Env overrides (useful for tests / non-default paths)

`OPENCODE_SESSIONS_EXPLORER_DB`, `OPENCODE_SESSIONS_EXPLORER_EXPORT_ROOT`,
`OPENCODE_SESSIONS_EXPLORER_TOOL_OUTPUT_DIR`, `OPENCODE_SESSIONS_EXPLORER_CK_BIN`.
`get-part` dereference is path-guarded to the tool-output whitelist (`lib/path-guard.ts`);
search snippets redact secrets by default (pass `redact:false` for local forensics only).
