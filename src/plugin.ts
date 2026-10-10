/**
 * opencode-sessions-explorer plugin — entry point (OpenCode V2 host only).
 *
 * Registers 18 tools that give the OpenCode LLM access to your OpenCode
 * session history: recall, search/grep, and historical analysis (17
 * read-only) plus one deliberate write (`unarchive-session`). See README.md for
 * the full tool catalog and intent triggers.
 *
 * Install (opencode.json):
 *   { "plugins": ["opencode-sessions-explorer"] }
 *
 * Local development: do NOT point `plugins` at a local path — OpenCode v2.0.26
 * cannot load one (see docs/install.md#from-source-dev). Instead build and copy
 * dist/plugin.js directly into ~/.config/opencode/plugins/ as a flat file:
 *   bun run build && cp dist/plugin.js ~/.config/opencode/plugins/opencode-sessions-explorer.js
 *
 * Required permission (opencode.json):
 *   {
 *     "permission": {
 *       "external_directory": { "~/.local/share/opencode/**": "allow" }
 *     }
 *   }
 *
 * Optional external dep: the `ck` CLI (cargo install ck-search) is needed by
 * search-text + grep-session. Without it those two tools return CK_NOT_FOUND
 * cleanly; the other 16 work fine.
 */
import { tools } from "./tools/index.js"
import { registerTools, type ToolEditor, type Location } from "./lib/tool-registration.js"

/**
 * OpenCode V2's loader calls `setup(ctx)` on this module's default export.
 * `ctx.tool.transform` is V2's registration API; `registerTools` (see
 * src/lib/tool-registration.ts) adapts our zod-based tool definitions to it.
 */
async function setup(ctx: {
  location: Location.Info
  tool: { transform(callback: (editor: ToolEditor) => void): Promise<unknown> }
}): Promise<void> {
  await ctx.tool.transform((editor) => {
    registerTools(editor, tools, ctx.location)
  })
}

export default {
  id: "opencode-sessions-explorer",
  setup,
}
