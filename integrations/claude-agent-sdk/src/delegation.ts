import type { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import type { Workflow } from '@mastra/core/workflows';
import { z } from 'zod';

import type { AnyMastraTool, MastraToolExecutionContext } from './mcp-bridge';

/**
 * Accept any `Agent<...>` regardless of its concrete generics. We only read
 * `id` / `name` / `description` and call `generate()`.
 */
export type AnyMastraAgent = Agent<string, any, any, any>;

/**
 * Accept any `Workflow<...>` regardless of its concrete generics. We only read
 * `id` / `description` / `inputSchema` and call `createRun().start()`.
 */
export type AnyMastraWorkflow = Workflow<any, any, string, any, any, any, any, any>;

/**
 * Build a synthetic Mastra `Tool` that delegates to a registered Mastra Agent
 * via `agent.generate({ message })` and returns the agent's final text.
 *
 * The shape intentionally mirrors what `@mastra/mcp`'s server exposes when it
 * advertises agents as tools — one required `message: string` field, and the
 * response collapses to the agent's `.text`. That single-field schema gives the
 * Claude model a clean, unambiguous call site ("ask this sub-agent a question")
 * instead of forcing it to invent a `MessageListInput` envelope.
 *
 * Returning a plain `AnyMastraTool` means this plugs into the same
 * `wrapMastraToolForSdk` / `buildMastraToolsMcpServer` pipeline as real tools —
 * the SDK side doesn't need to know agents are a separate concept.
 */
export function buildAgentDelegationTool(key: string, agent: AnyMastraAgent): AnyMastraTool {
  const description = agent.getDescription?.() ?? `Delegate a question to the '${agent.name}' Mastra agent.`;

  return createTool({
    id: key,
    description,
    inputSchema: z.object({
      message: z
        .string()
        .describe(`The question or instructions to send to the '${agent.name}' agent.`),
    }),
    execute: async ({ message }, context) => {
      const response = await agent.generate(message, {
        requestContext: context?.requestContext,
      });
      return { text: response.text };
    },
  });
}

/**
 * Build a synthetic Mastra `Tool` that runs a registered Mastra Workflow.
 *
 * Preserves the workflow's own `inputSchema` so the model sees the real field
 * names/types — no wrapping in `{ inputData: ... }`, because the SDK's MCP
 * contract is "handler args == validated input". Internally we unwrap into
 * `run.start({ inputData })` like every other Mastra caller.
 *
 * Throws at build time (not at tool-call time) if the workflow lacks a
 * description or inputSchema, because an undescribed / unschematized workflow
 * is unusable by a model anyway.
 */
export function buildWorkflowDelegationTool(key: string, workflow: AnyMastraWorkflow): AnyMastraTool {
  if (!workflow.description) {
    throw new Error(
      `Workflow '${workflow.id}' (key: '${key}') must have a non-empty description to be delegated to Claude.`,
    );
  }
  if (!workflow.inputSchema) {
    throw new Error(
      `Workflow '${workflow.id}' (key: '${key}') must have an inputSchema to be delegated to Claude.`,
    );
  }

  return createTool({
    id: key,
    description: `Run workflow '${key}'. ${workflow.description}`,
    inputSchema: workflow.inputSchema,
    execute: async (inputData, context) => {
      const run = await workflow.createRun();
      const result = await run.start({
        inputData,
        requestContext: context?.requestContext,
      });

      if (result.status === 'success') {
        return { status: 'success', result: result.result };
      }

      if (result.status === 'failed') {
        // Surface as a thrown error so `wrapMastraToolForSdk` routes it into an
        // `isError: true` CallToolResult, keeping SDK and model on the same page
        // about the tool having actually failed.
        throw result.error ?? new Error(`Workflow '${key}' failed.`);
      }

      // Anything else (suspended, etc.) isn't a valid one-shot tool outcome.
      throw new Error(`Workflow '${key}' ended in non-terminal state: ${result.status}`);
    },
  });
}

/**
 * Convenience: turn every registered agent (except the `self` key) and every
 * workflow into synthetic Mastra tools, then merge them with the caller's own
 * tools. The resulting record can be passed straight to
 * `buildMastraToolsMcpServer`.
 *
 * `selfAgentKey` lets callers exclude the Claude agent itself from its own
 * delegation surface — otherwise the model would see a tool that just proxies
 * straight back to itself.
 */
export function mergeDelegationTools(input: {
  tools?: Record<string, AnyMastraTool>;
  agents?: Record<string, AnyMastraAgent>;
  workflows?: Record<string, AnyMastraWorkflow>;
  selfAgentKey?: string;
}): Record<string, AnyMastraTool> {
  const merged: Record<string, AnyMastraTool> = { ...(input.tools ?? {}) };

  for (const [key, agent] of Object.entries(input.agents ?? {})) {
    if (key === input.selfAgentKey) continue;
    if (merged[key]) {
      // Explicit tools beat synthetic delegation tools so callers can override.
      continue;
    }
    merged[key] = buildAgentDelegationTool(key, agent);
  }

  for (const [key, workflow] of Object.entries(input.workflows ?? {})) {
    if (merged[key]) continue;
    merged[key] = buildWorkflowDelegationTool(key, workflow);
  }

  return merged;
}

// Re-export so callers can fabricate typed `MastraToolExecutionContext` values
// without pulling from mcp-bridge explicitly.
export type { MastraToolExecutionContext };
