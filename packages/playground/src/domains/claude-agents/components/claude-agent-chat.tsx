import type { ClaudeAgentSessionResponse, ClaudeAgentSummary } from '@mastra/client-js';
import { Loader2, Send } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useClaudeAgentSession,
  useStreamClaudeAgentTurn,
} from '../hooks/use-claude-agents';
import { parseClaudeAgentStream } from './parse-chunk-stream';
import { useLinkComponent } from '@/lib/framework';

type Role = 'user' | 'assistant';

interface ChatMessage {
  id: string;
  role: Role;
  text: string;
  pending?: boolean;
}

function extractMessagesFromSession(session?: ClaudeAgentSessionResponse): ChatMessage[] {
  if (!session?.messages) return [];
  const out: ChatMessage[] = [];
  for (const raw of session.messages) {
    const msg = raw as {
      type?: string;
      message?: { content?: unknown; role?: string };
      uuid?: string;
    };

    if (msg.type === 'user') {
      const text = contentToText(msg.message?.content);
      if (text) out.push({ id: msg.uuid ?? `u-${out.length}`, role: 'user', text });
      continue;
    }
    if (msg.type === 'assistant') {
      const text = contentToText(msg.message?.content);
      if (text) out.push({ id: msg.uuid ?? `a-${out.length}`, role: 'assistant', text });
    }
  }
  return out;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const t = (block as { text?: unknown }).text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('');
}

export interface ClaudeAgentChatProps {
  agent: ClaudeAgentSummary;
  sessionId: string; // may be "new"
}

export function ClaudeAgentChat({ agent, sessionId }: ClaudeAgentChatProps) {
  const { navigate, paths } = useLinkComponent();
  const isNew = sessionId === 'new';

  const { data: session, isLoading: sessionLoading } = useClaudeAgentSession(agent.id, isNew ? undefined : sessionId);
  const streamTurn = useStreamClaudeAgentTurn(agent.id);

  const persistedMessages = useMemo(() => extractMessagesFromSession(session), [session]);
  const [liveMessages, setLiveMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const allMessages = useMemo(() => [...persistedMessages, ...liveMessages], [persistedMessages, liveMessages]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [allMessages]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const prompt = input.trim();
      if (!prompt || isStreaming) return;
      setInput('');
      setError(null);
      setIsStreaming(true);

      const userMsgId = `u-live-${Date.now()}`;
      const asstMsgId = `a-live-${Date.now()}`;
      setLiveMessages(prev => [
        ...prev,
        { id: userMsgId, role: 'user', text: prompt },
        { id: asstMsgId, role: 'assistant', text: '', pending: true },
      ]);

      try {
        const response = await streamTurn(sessionId, { prompt });
        let mintedSessionId: string | undefined;
        const textBuffers = new Map<string, string>();

        for await (const chunk of parseClaudeAgentStream(response)) {
          if (chunk.type === 'data-claude-agent-session') {
            const data = chunk.data as { sessionId?: string } | undefined;
            if (data?.sessionId) mintedSessionId = data.sessionId;
            continue;
          }
          if (chunk.type === 'text-delta') {
            const p = chunk.payload as { id?: string; text?: string } | undefined;
            if (!p?.id || typeof p.text !== 'string') continue;
            const prev = textBuffers.get(p.id) ?? '';
            const next = prev + p.text;
            textBuffers.set(p.id, next);
            const combined = Array.from(textBuffers.values()).join('');
            setLiveMessages(curr =>
              curr.map(m => (m.id === asstMsgId ? { ...m, text: combined, pending: true } : m)),
            );
            continue;
          }
          if (chunk.type === 'finish' || chunk.type === 'step-finish') {
            setLiveMessages(curr =>
              curr.map(m => (m.id === asstMsgId ? { ...m, pending: false } : m)),
            );
            continue;
          }
          if (chunk.type === 'error') {
            const p = chunk.payload as { error?: string } | undefined;
            setError(p?.error ?? 'Stream error');
          }
        }

        // On new session, navigate to the minted id once the stream finishes.
        if (isNew && mintedSessionId) {
          navigate(paths.claudeAgentSessionLink(agent.id, mintedSessionId));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Stream failed');
      } finally {
        setIsStreaming(false);
      }
    },
    [agent.id, input, isNew, isStreaming, navigate, paths, sessionId, streamTurn],
  );

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {sessionLoading && !isNew ? (
            <div className="flex justify-center py-10 text-sm text-icon3">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : null}

          {allMessages.length === 0 && !sessionLoading ? (
            <div className="py-10 text-center text-sm text-icon3">
              Say hi to <span className="font-medium">{agent.name ?? agent.id}</span>
            </div>
          ) : null}

          {allMessages.map(msg => (
            <MessageRow key={msg.id} message={msg} />
          ))}
        </div>
      </div>

      {error ? (
        <div className="border-t border-border1 bg-destructive/10 px-4 py-2 text-xs text-destructive">{error}</div>
      ) : null}

      <form onSubmit={handleSubmit} className="border-t border-border1 px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSubmit(e);
              }
            }}
            placeholder="Message Claude..."
            rows={1}
            disabled={isStreaming}
            className="min-h-[44px] flex-1 resize-none rounded-md border border-border1 bg-surface1 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="submit"
            disabled={!input.trim() || isStreaming}
            className="inline-flex h-11 w-11 items-center justify-center rounded-md bg-accent text-accent-foreground disabled:opacity-50"
            aria-label="Send"
          >
            {isStreaming ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </button>
        </div>
      </form>
    </div>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
          isUser ? 'bg-accent text-accent-foreground' : 'bg-surface2 text-icon6'
        }`}
      >
        {message.text || (message.pending ? <Loader2 className="size-3 animate-spin" /> : null)}
      </div>
    </div>
  );
}
