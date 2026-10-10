/**
 * Adapts this plugin's zod-based `tool()` definitions to OpenCode V2's
 * `ctx.tool.transform(editor => editor.add(...))` registration API, which
 * takes JSON Schema input (not zod) and a different per-call tool context
 * (no `directory`/`worktree`, `progress()` instead of `metadata()`, no `ask()`).
 *
 * `ToolContext`/`ToolEditor` are the real V2 SDK types (`@opencode/plugin`,
 * devDependency, type-only); `Location` comes from `@opencode/schema`
 * (transitive dep of `@opencode/plugin`, resolved for types only).
 */
import { z } from "zod"
import type { ToolDefinition, ToolContext as V1ToolContext } from "@opencode-ai/plugin"
import type { ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import type { Location } from "@opencode/schema/location"

export type { ToolContext, ToolEditor }
export type { Location }

function argsToJsonSchema(args: Record<string, z.ZodTypeAny>): unknown {
  return z.toJSONSchema(z.object(args))
}

function toV1Context(ctx: ToolContext, location: Location.Info): V1ToolContext {
  return {
    sessionID: ctx.sessionID,
    messageID: ctx.messageID,
    agent: ctx.agent,
    directory: location.directory,
    worktree: location.project?.directory ?? location.directory,
    abort: ctx.signal,
    metadata(input) {
      void ctx.progress(input)
    },
    async ask() {
      throw new Error("opencode-sessions-explorer: ask() is not supported under OpenCode V2 yet")
    },
  }
}

/** Register every tool definition from `tools` onto a V2 tool editor. */
export function registerTools(
  editor: ToolEditor,
  tools: Record<string, ToolDefinition>,
  location: Location.Info,
): void {
  for (const [name, def] of Object.entries(tools)) {
    const inputSchema = argsToJsonSchema(def.args as unknown as Record<string, z.ZodTypeAny>)
    editor.add({
      name,
      description: def.description,
      input: inputSchema as any,
      async execute(input, ctx) {
        const result = await def.execute(input as any, toV1Context(ctx, location))
        const text = typeof result === "string" ? result : result.output
        return { content: text }
      },
    })
  }
}
