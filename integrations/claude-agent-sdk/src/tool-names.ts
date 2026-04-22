/**
 * Tool-name qualification helpers.
 *
 * The Claude Agent SDK exposes tools to the model under an `mcp__<server>__<tool>`
 * namespace. Mastra hosts an in-process MCP server named `mastra` that proxies
 * all registered Mastra tools (including agents and workflows wrapped as tools)
 * to the SDK. Anything we register on that server must be qualified on the way
 * out and unqualified on the way back in — the SDK announces qualified names to
 * the model, the model passes qualified names into `canUseTool`, and we look
 * the tool back up using the unqualified id.
 *
 * Keeping this logic in one place means there is exactly one definition of the
 * namespace prefix. Every call site that qualifies or unqualifies a Mastra tool
 * must go through these helpers — do not hand-build `mcp__mastra__*` strings.
 */

/** Name of the in-process MCP server Mastra exposes to the SDK. */
export const MASTRA_MCP_SERVER_NAME = 'mastra';

/** Prefix the SDK prepends to every MCP tool name advertised to the model. */
const MASTRA_MCP_PREFIX = `mcp__${MASTRA_MCP_SERVER_NAME}__`;

/**
 * Qualify a Mastra tool id with the MCP namespace so the Claude Agent SDK
 * recognises it as a hosted tool.
 *
 * Example: `writeNote` → `mcp__mastra__writeNote`.
 *
 * Throws if the input is empty or already qualified — qualifying a qualified
 * name is almost always a bug (it means some call site forgot to unqualify
 * first), and we prefer to surface that loudly rather than silently double-
 * prefix.
 */
export function qualifyMastraToolName(id: string): string {
  if (!id) {
    throw new Error('qualifyMastraToolName: tool id must be a non-empty string');
  }
  if (isQualifiedMastraToolName(id)) {
    throw new Error(`qualifyMastraToolName: "${id}" is already qualified; did you mean unqualifyMastraToolName?`);
  }
  return `${MASTRA_MCP_PREFIX}${id}`;
}

/**
 * Strip the MCP namespace prefix from a qualified tool name so it can be used
 * to look up the underlying Mastra tool in its registry.
 *
 * Returns the input unchanged when it does not carry the Mastra MCP prefix —
 * this makes the helper safe to call on names that may or may not be qualified
 * (e.g. inside `canUseTool`, where the SDK may pass built-in tool names like
 * `Read` alongside our qualified tools).
 */
export function unqualifyMastraToolName(name: string): string {
  return isQualifiedMastraToolName(name) ? name.slice(MASTRA_MCP_PREFIX.length) : name;
}

/** True when `name` is a Mastra-hosted MCP tool (i.e. carries our prefix). */
export function isQualifiedMastraToolName(name: string): boolean {
  return typeof name === 'string' && name.startsWith(MASTRA_MCP_PREFIX);
}
