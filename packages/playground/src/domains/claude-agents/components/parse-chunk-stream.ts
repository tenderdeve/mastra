/**
 * Consume an SSE stream from the Claude Agent stream endpoint and yield
 * parsed Mastra `ChunkType` payloads. The server wire format is:
 *
 *     data: {...chunk json...}\n\n
 *     ...
 *     data: [DONE]\n\n
 *
 * We only care about `text-delta` / `tool-call` / `tool-result` /
 * `data-claude-agent-session` for the MVP renderer.
 */
export type ParsedChunk = {
  type: string;
  runId?: string;
  payload?: Record<string, unknown>;
  data?: unknown;
  transient?: boolean;
};

export async function* parseClaudeAgentStream(response: Response): AsyncGenerator<ParsedChunk, void, void> {
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Stream failed: ${response.status} ${response.statusText} ${text}`);
  }
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nlIdx: number;
      while ((nlIdx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 2);
        const line = raw.replace(/^data:\s*/, '').trim();
        if (!line) continue;
        if (line === '[DONE]') return;
        try {
          yield JSON.parse(line) as ParsedChunk;
        } catch {
          // ignore malformed frames
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
