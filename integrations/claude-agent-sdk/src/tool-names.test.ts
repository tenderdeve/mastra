import { describe, expect, it } from 'vitest';
import {
  MASTRA_MCP_SERVER_NAME,
  isQualifiedMastraToolName,
  qualifyMastraToolName,
  unqualifyMastraToolName,
} from './tool-names';

describe('qualifyMastraToolName', () => {
  it('prepends the mastra MCP prefix', () => {
    expect(qualifyMastraToolName('writeNote')).toBe('mcp__mastra__writeNote');
  });

  it('matches MASTRA_MCP_SERVER_NAME constant', () => {
    expect(qualifyMastraToolName('x')).toBe(`mcp__${MASTRA_MCP_SERVER_NAME}__x`);
  });

  it('throws on an empty id', () => {
    expect(() => qualifyMastraToolName('')).toThrow(/non-empty/);
  });

  it('throws when asked to qualify an already-qualified name', () => {
    // Double-prefixing is always a bug: it means some call site forgot to
    // unqualify before re-qualifying. Surface it loudly.
    expect(() => qualifyMastraToolName('mcp__mastra__writeNote')).toThrow(/already qualified/);
  });
});

describe('unqualifyMastraToolName', () => {
  it('strips the mastra MCP prefix', () => {
    expect(unqualifyMastraToolName('mcp__mastra__writeNote')).toBe('writeNote');
  });

  it('is a no-op for unqualified names (safe to call twice)', () => {
    expect(unqualifyMastraToolName('writeNote')).toBe('writeNote');
  });

  it('leaves other MCP server prefixes alone', () => {
    // The SDK can host multiple MCP servers; we should only strip our own.
    expect(unqualifyMastraToolName('mcp__other__writeNote')).toBe('mcp__other__writeNote');
  });

  it('leaves SDK built-in tool names alone', () => {
    // The SDK passes built-ins like "Read", "Write", "Bash" through the same
    // code path in canUseTool — unqualify must not mangle them.
    expect(unqualifyMastraToolName('Read')).toBe('Read');
    expect(unqualifyMastraToolName('AskUserQuestion')).toBe('AskUserQuestion');
  });
});

describe('isQualifiedMastraToolName', () => {
  it('returns true for names with the mastra MCP prefix', () => {
    expect(isQualifiedMastraToolName('mcp__mastra__writeNote')).toBe(true);
  });

  it('returns false for unqualified names', () => {
    expect(isQualifiedMastraToolName('writeNote')).toBe(false);
  });

  it('returns false for other MCP server prefixes', () => {
    expect(isQualifiedMastraToolName('mcp__other__writeNote')).toBe(false);
  });

  it('returns false for non-string inputs without throwing', () => {
    expect(isQualifiedMastraToolName(undefined as unknown as string)).toBe(false);
    expect(isQualifiedMastraToolName(null as unknown as string)).toBe(false);
  });
});

describe('qualify/unqualify round trip', () => {
  it.each(['writeNote', 'echo', 'my-tool', 'some.namespaced.tool', 'tool_with_underscores'])('round-trips %s', id => {
    expect(unqualifyMastraToolName(qualifyMastraToolName(id))).toBe(id);
  });
});
