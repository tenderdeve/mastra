import { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ClaudeAgent } from './claude-agent';
import { buildMastraToolsMcpServer } from './mcp-bridge';
import {
  ASK_USER_QUESTION_TOOL_NAME,
  NON_ESSENTIAL_SUPPRESSION_ENV,
  buildQueryOptions,
  normalizeSystemPrompt,
} from './query-options';

const emptyContext = () => ({ mastra: {} as never, requestContext: {} as never });

const emptyBridge = () => buildMastraToolsMcpServer({}, emptyContext);

describe('normalizeSystemPrompt', () => {
  it('returns undefined when no prompt is set', () => {
    expect(normalizeSystemPrompt(undefined)).toBeUndefined();
  });

  it('wraps a plain string as an append on the claude_code preset', () => {
    expect(normalizeSystemPrompt('Be terse.')).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Be terse.',
    });
  });

  it('forwards preset objects as-is (no append)', () => {
    expect(normalizeSystemPrompt({ type: 'preset', preset: 'claude_code' })).toEqual({
      type: 'preset',
      preset: 'claude_code',
    });
  });

  it('forwards preset objects as-is (with append)', () => {
    expect(normalizeSystemPrompt({ type: 'preset', preset: 'claude_code', append: 'hi' })).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'hi',
    });
  });

  it('unwraps { type: "string" } to the raw string (replaces preset)', () => {
    expect(normalizeSystemPrompt({ type: 'string', value: 'custom' })).toBe('custom');
  });
});

describe('buildQueryOptions', () => {
  it('includes MCP bridge, cache-warmup env, and AskUserQuestion on a minimal agent', () => {
    const agent = new ClaudeAgent({ id: 'demo' });
    const baseEnv = { PATH: '/usr/bin' };

    const options = buildQueryOptions(agent, { mastraMcp: emptyBridge(), baseEnv });

    expect(options.mcpServers?.mastra).toBeDefined();
    expect(options.allowedTools).toContain(ASK_USER_QUESTION_TOOL_NAME);
    expect(options.env?.PATH).toBe('/usr/bin');
    // cache-warmup suppression is on by default.
    for (const [k, v] of Object.entries(NON_ESSENTIAL_SUPPRESSION_ENV)) {
      expect(options.env?.[k]).toBe(v);
    }
    // partial messages default-on.
    expect(options.includePartialMessages).toBe(true);
  });

  it('omits cache-warmup env when disableNonEssentialModelCalls is false', () => {
    const agent = new ClaudeAgent({ id: 'demo', disableNonEssentialModelCalls: false });
    const options = buildQueryOptions(agent, { mastraMcp: emptyBridge(), baseEnv: {} });
    expect(options.env?.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBeUndefined();
    expect(options.env?.DISABLE_PROMPT_CACHING_WARMUP).toBeUndefined();
  });

  it('threads model, cwd, and permissionMode when set on the agent', () => {
    const agent = new ClaudeAgent({
      id: 'demo',
      model: 'sonnet',
      cwd: '/tmp/work',
      permissionMode: 'acceptEdits',
    });
    const options = buildQueryOptions(agent, { mastraMcp: emptyBridge(), baseEnv: {} });
    expect(options.model).toBe('sonnet');
    expect(options.cwd).toBe('/tmp/work');
    expect(options.permissionMode).toBe('acceptEdits');
  });

  it('per-turn permissionMode overrides agent default', () => {
    const agent = new ClaudeAgent({ id: 'demo', permissionMode: 'acceptEdits' });
    const options = buildQueryOptions(agent, {
      mastraMcp: emptyBridge(),
      baseEnv: {},
      permissionMode: 'plan',
    });
    expect(options.permissionMode).toBe('plan');
  });

  it('normalizes systemPrompt to preset+append on a plain string', () => {
    const agent = new ClaudeAgent({ id: 'demo', systemPrompt: 'Be terse.' });
    const options = buildQueryOptions(agent, { mastraMcp: emptyBridge(), baseEnv: {} });
    expect(options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'Be terse.' });
  });

  it('propagates approval-gated filtering from the MCP bridge into allowedTools', () => {
    const tools = {
      safe: createTool({
        id: 'safe',
        description: 'noop',
        inputSchema: z.object({ x: z.string() }),
        execute: async () => 'ok',
      }),
      gated: createTool({
        id: 'gated',
        description: 'noop',
        inputSchema: z.object({ x: z.string() }),
        requireApproval: true,
        execute: async () => 'ok',
      }),
    };
    const bridge = buildMastraToolsMcpServer(tools, emptyContext);
    const agent = new ClaudeAgent({ id: 'demo' });
    const options = buildQueryOptions(agent, { mastraMcp: bridge, baseEnv: {} });
    expect(options.allowedTools).toContain('mcp__mastra__safe');
    expect(options.allowedTools).not.toContain('mcp__mastra__gated');
    expect(options.allowedTools).toContain(ASK_USER_QUESTION_TOOL_NAME);
  });

  it('forwards subagents to the SDK agents option', () => {
    const sub = { description: 'helper', prompt: 'you help' };
    const agent = new ClaudeAgent({ id: 'demo', subagents: { helper: sub } });
    const options = buildQueryOptions(agent, { mastraMcp: emptyBridge(), baseEnv: {} });
    expect(options.agents).toEqual({ helper: sub });
  });

  it('omits the agents key when there are no subagents', () => {
    const agent = new ClaudeAgent({ id: 'demo' });
    const options = buildQueryOptions(agent, { mastraMcp: emptyBridge(), baseEnv: {} });
    expect(options.agents).toBeUndefined();
  });

  it('wires canUseTool + abortController through when provided', () => {
    const agent = new ClaudeAgent({ id: 'demo' });
    const controller = new AbortController();
    const canUseTool = async () => ({ behavior: 'allow' as const });
    const options = buildQueryOptions(agent, {
      mastraMcp: emptyBridge(),
      baseEnv: {},
      canUseTool,
      abortController: controller,
    });
    expect(options.canUseTool).toBe(canUseTool);
    expect(options.abortController).toBe(controller);
  });

  it('prefers resume over continue/sessionId when both are supplied', () => {
    const agent = new ClaudeAgent({ id: 'demo' });
    const options = buildQueryOptions(agent, {
      mastraMcp: emptyBridge(),
      baseEnv: {},
      resume: 'abc',
      continueRecent: true,
      sessionId: 'ignored',
      forkSession: true,
    });
    expect(options.resume).toBe('abc');
    expect(options.forkSession).toBe(true);
    expect(options.continue).toBeUndefined();
    expect(options.sessionId).toBeUndefined();
  });

  it('falls back to continueRecent when resume is not set', () => {
    const agent = new ClaudeAgent({ id: 'demo' });
    const options = buildQueryOptions(agent, {
      mastraMcp: emptyBridge(),
      baseEnv: {},
      continueRecent: true,
    });
    expect(options.continue).toBe(true);
    expect(options.resume).toBeUndefined();
  });

  it('uses a custom sessionId when starting fresh', () => {
    const agent = new ClaudeAgent({ id: 'demo' });
    const options = buildQueryOptions(agent, {
      mastraMcp: emptyBridge(),
      baseEnv: {},
      sessionId: 'brand-new-uuid',
    });
    expect(options.sessionId).toBe('brand-new-uuid');
  });

  it('merges extraEnv on top of base + cache-warmup env', () => {
    const agent = new ClaudeAgent({ id: 'demo' });
    const options = buildQueryOptions(agent, {
      mastraMcp: emptyBridge(),
      baseEnv: { PATH: '/usr/bin' },
      extraEnv: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318', DISABLE_AUTOUPDATER: '0' },
    });
    expect(options.env?.PATH).toBe('/usr/bin');
    expect(options.env?.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:4318');
    // extraEnv wins over the cache-warmup defaults.
    expect(options.env?.DISABLE_AUTOUPDATER).toBe('0');
    expect(options.env?.DISABLE_NON_ESSENTIAL_MODEL_CALLS).toBe('1');
  });

  it('respects explicit includePartialMessages = false', () => {
    const agent = new ClaudeAgent({ id: 'demo' });
    const options = buildQueryOptions(agent, {
      mastraMcp: emptyBridge(),
      baseEnv: {},
      includePartialMessages: false,
    });
    expect(options.includePartialMessages).toBe(false);
  });
});
