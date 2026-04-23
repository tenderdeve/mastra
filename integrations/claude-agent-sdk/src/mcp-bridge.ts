import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import type { Mastra } from '@mastra/core';
import type { RequestContext } from '@mastra/core/request-context';
import { standardSchemaToJSONSchema } from '@mastra/core/schema';
import type { Tool } from '@mastra/core/tools';
import { jsonSchemaToZod } from '@mastra/schema-compat/json-to-zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { MASTRA_MCP_SERVER_NAME, qualifyMastraToolName } from './tool-names';

/**
 * Accept any shape of Mastra Tool without forcing call sites to fight invariant
 * generics. The bridge only reads `inputSchema`, `description`, `execute`, and
 * `requireApproval` — none of which care about the concrete input/output types.
 */
export type AnyMastraTool = Tool<any, any, any, any, any, any, any>;

/**
 * Build result for the MCP bridge.
 *
 * - `server` is handed to the SDK via `options.mcpServers[MASTRA_MCP_SERVER_NAME] = server`.
 * - `allowedTools` is appended to the SDK's `allowedTools` so the model sees the bridge
 *   tools as first-class, but only for tools that don't require approval — approval-gated
 *   tools stay off `allowedTools` so the SDK routes them through `canUseTool` instead of
 *   auto-approving.
 */
export type MastraToolsMcpServer = {
  server: McpSdkServerConfigWithInstance;
  allowedTools: string[];
};

/**
 * Runtime values the stream loop threads into tool handlers. Created per turn.
 *
 * `requestContext` is the Mastra RequestContext for this turn. `abortSignal` is the
 * stream's AbortSignal so tools get cancelled when the client disconnects. `mastra` is
 * the owning instance so tools can resolve other primitives (storage, agents, etc).
 */
export type MastraToolExecutionContext = {
  mastra: Mastra;
  requestContext: RequestContext;
  abortSignal?: AbortSignal;
};

/**
 * Extract a Zod raw shape from a Mastra tool's `inputSchema`.
 *
 * Mastra stores `inputSchema` as `StandardSchemaWithJSON`, which is a wrapper built with
 * `Object.create(zodSchema)`. That means prototype access on the wrapper reaches back to
 * the original Zod schema, so `.shape` is available for free when the user wrote
 * `createTool({ inputSchema: z.object({...}) })`.
 *
 * When the tool was built from a non-Zod source (JSON Schema, AI SDK Schema, ArkType,
 * etc.) we fall back to converting the JSON Schema representation back into Zod via
 * `jsonSchemaToZod`. This is lossy for exotic Zod features but round-trips correctly for
 * the shapes models actually produce (object of primitives/arrays/enums/nested objects).
 *
 * The SDK's `tool()` helper requires a `ZodRawShape` — the object literal that sits
 * inside `z.object({...})` — not the object schema itself. So we unwrap once.
 *
 * Returns `null` when the tool has no schema or when fallback conversion fails.
 */
export function extractZodShape(tool: AnyMastraTool): z.ZodRawShape | null {
  const schema = tool.inputSchema;
  if (!schema) return null;

  // Fast path: the wrapper inherits `.shape` from the original Zod object via prototype.
  // Works for both Zod v3 (ZodObject) and Zod v4 (z.object) because both expose `.shape`.
  const maybeShape = (schema as unknown as { shape?: unknown }).shape;
  if (maybeShape && isZodRawShape(maybeShape)) {
    return maybeShape;
  }

  // Fallback: non-Zod standard schemas. Convert to JSON Schema, then to Zod code, then
  // instantiate. We only accept the result if it comes back as a ZodObject — anything
  // else means the tool's top-level input isn't an object, which MCP doesn't support.
  try {
    const jsonSchema = standardSchemaToJSONSchema(schema);
    if (!jsonSchema || typeof jsonSchema !== 'object') return null;
    const zodCode = jsonSchemaToZod(jsonSchema as Parameters<typeof jsonSchemaToZod>[0]);
    const zodSchema = Function('z', `"use strict";return (${zodCode});`)(z) as z.ZodTypeAny;
    const shape = (zodSchema as unknown as { shape?: unknown }).shape;
    if (shape && isZodRawShape(shape)) return shape;
  } catch {
    // Fall through — caller will skip the tool.
  }

  return null;
}

function isZodRawShape(value: unknown): value is z.ZodRawShape {
  if (!value || typeof value !== 'object') return false;
  for (const v of Object.values(value as Record<string, unknown>)) {
    // ZodType instances always carry a `_def` (v3) or `_zod` (v4). Checking for either is
    // cheaper and more robust than instanceof given multiple Zod versions may coexist.
    const hasDef = typeof v === 'object' && v !== null && ('_def' in v || '_zod' in v);
    if (!hasDef) return false;
  }
  return true;
}

/**
 * Wrap a single Mastra tool as an `SdkMcpToolDefinition` the Agent SDK can expose to the
 * model. Returns `null` when the tool is unusable (no schema, no execute, or schema
 * extraction failed) — the caller should skip it rather than register a broken tool.
 *
 * The wrapped tool name is **unqualified** here; qualification (`mcp__mastra__*`) happens
 * when we build the `allowedTools` list, because that's the shape the SDK uses externally.
 */
export function wrapMastraToolForSdk(
  id: string,
  tool: AnyMastraTool,
  getContext: () => MastraToolExecutionContext,
): SdkMcpToolDefinition | null {
  const shape = extractZodShape(tool);
  if (!shape) return null;
  if (!tool.execute) return null;

  return sdkTool(
    id,
    tool.description ?? `Mastra tool: ${id}`,
    shape,
    async (args): Promise<CallToolResult> => {
      const ctx = getContext();
      try {
        const result = await tool.execute!(args as never, {
          mastra: ctx.mastra,
          requestContext: ctx.requestContext,
          abortSignal: ctx.abortSignal,
        } as never);
        return toCallToolResult(result);
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
  );
}

/**
 * Coerce a Mastra tool's execute() return value into the `CallToolResult` shape MCP
 * expects. Mastra tools return raw JSON-shaped values; MCP needs a `content[]` array
 * with typed entries. Stringifying the whole thing as a single text entry keeps the
 * model's view identical to what it would see from a stringified JSON tool result
 * elsewhere in the ecosystem.
 */
function toCallToolResult(value: unknown): CallToolResult {
  if (value && typeof value === 'object' && 'content' in value && Array.isArray((value as { content: unknown }).content)) {
    // Tool already returned an MCP-shaped result; pass through unchanged.
    return value as CallToolResult;
  }
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value ?? null),
      },
    ],
  };
}

/**
 * Build the Mastra MCP server the SDK will mount alongside its own built-in tools.
 *
 * Returned `allowedTools` is the list of qualified names (e.g. `mcp__mastra__writeNote`)
 * that should be appended to the SDK's `allowedTools` option. Approval-gated tools are
 * deliberately **excluded** from this list — if they appeared the SDK would auto-approve
 * them and `canUseTool` would never fire, defeating the approval contract.
 */
export function buildMastraToolsMcpServer(
  tools: Record<string, AnyMastraTool>,
  getContext: () => MastraToolExecutionContext,
): MastraToolsMcpServer {
  const sdkTools: SdkMcpToolDefinition[] = [];
  const allowedTools: string[] = [];

  for (const [id, tool] of Object.entries(tools)) {
    const wrapped = wrapMastraToolForSdk(id, tool, getContext);
    if (!wrapped) continue;
    sdkTools.push(wrapped);
    if (!tool.requireApproval) {
      allowedTools.push(qualifyMastraToolName(id));
    }
  }

  const server = createSdkMcpServer({
    name: MASTRA_MCP_SERVER_NAME,
    tools: sdkTools,
  });

  return { server, allowedTools };
}
