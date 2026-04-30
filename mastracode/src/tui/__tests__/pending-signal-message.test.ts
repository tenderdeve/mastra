import { describe, expect, it, vi } from 'vitest';
import { addPendingSignalMessage, addUserMessage, removePendingSignalMessage } from '../render-messages.js';
import type { TUIState } from '../state.js';

function createState(): TUIState {
  const chatContainer = {
    children: [] as unknown[],
    addChild: vi.fn((child: unknown) => chatContainer.children.push(child)),
    removeChild: vi.fn((child: unknown) => {
      const idx = chatContainer.children.indexOf(child);
      if (idx >= 0) chatContainer.children.splice(idx, 1);
    }),
    invalidate: vi.fn(),
    clear: vi.fn(() => {
      chatContainer.children = [];
    }),
  };

  return {
    chatContainer,
    pendingSignalMessageComponentsById: new Map(),
    messageComponentsById: new Map(),
    followUpComponents: [],
    streamingComponent: undefined,
    harness: { getDisplayState: () => ({ isRunning: true }) },
    ui: { requestRender: vi.fn() },
    toolOutputExpanded: false,
    allSystemReminderComponents: [],
    allSlashCommandComponents: [],
    seenToolCallIds: new Set(),
    subagentToolCallIds: new Set(),
    currentRunSystemReminderKeys: new Set(),
  } as unknown as TUIState;
}

describe('pending signal messages', () => {
  it('renders pending messages outside chat history and removes them by id', () => {
    const state = createState();

    addPendingSignalMessage(state, { id: 'user-1', content: 'thanks' });

    expect(state.pendingSignalMessageComponentsById.has('user-1')).toBe(true);
    expect(state.chatContainer.children).toHaveLength(1);

    expect(removePendingSignalMessage(state, 'user-1')).toBe(true);
    expect(state.pendingSignalMessageComponentsById.has('user-1')).toBe(false);
    expect(state.chatContainer.children).toHaveLength(0);
  });

  it('keeps pending messages pinned below streamed history', () => {
    const state = createState();
    addPendingSignalMessage(state, { id: 'pending-1', content: 'pending' });

    addUserMessage(state, {
      id: 'user-1',
      role: 'user',
      content: [{ type: 'text', text: 'streamed' }],
      createdAt: new Date(),
    });

    expect(state.pendingSignalMessageComponentsById.has('pending-1')).toBe(true);
    expect(state.messageComponentsById.has('user-1')).toBe(true);
    expect(state.chatContainer.children).toEqual([
      state.messageComponentsById.get('user-1'),
      state.pendingSignalMessageComponentsById.get('pending-1'),
    ]);
  });

  it('discards pending message when the stream confirms the canonical user message', () => {
    const state = createState();
    addPendingSignalMessage(state, { id: 'user-1', content: 'thanks' });

    addUserMessage(state, {
      id: 'user-1',
      role: 'user',
      content: [{ type: 'text', text: 'thanks' }],
      createdAt: new Date(),
    });

    expect(state.pendingSignalMessageComponentsById.has('user-1')).toBe(false);
    expect(state.followUpComponents).toEqual([]);
    expect(state.messageComponentsById.has('user-1')).toBe(true);
    expect(state.chatContainer.children).toEqual([state.messageComponentsById.get('user-1')]);
  });
});
