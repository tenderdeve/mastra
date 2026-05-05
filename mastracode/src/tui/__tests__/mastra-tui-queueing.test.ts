import { Container } from '@mariozechner/pi-tui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addUserMessage: vi.fn(),
  showInfo: vi.fn(),
  showError: vi.fn(),
}));

vi.mock('../render-messages.js', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    addUserMessage: mocks.addUserMessage,
  };
});

vi.mock('../display.js', () => ({
  showInfo: mocks.showInfo,
  showError: mocks.showError,
  showFormattedError: vi.fn(),
  notify: vi.fn(),
}));

import { handleAgentEnd } from '../handlers/agent-lifecycle.js';
import type { EventHandlerContext } from '../handlers/types.js';
import { MastraTUI, consumePendingImages } from '../mastra-tui.js';
import type { TUIState } from '../state.js';

function createQueueState(overrides: Partial<TUIState> = {}): TUIState {
  return {
    harness: {
      getFollowUpCount: vi.fn(() => 0),
    },
    gradientAnimator: undefined,
    projectInfo: { rootPath: '.', gitBranch: 'main' } as TUIState['projectInfo'],
    streamingComponent: undefined,
    streamingMessage: undefined,
    followUpComponents: [],
    pendingSignalMessageComponentsById: new Map(),
    pendingFollowUpMessages: [],
    pendingQueuedActions: [],
    pendingSlashCommands: [],
    pendingTools: new Map(),
    chatContainer: { children: [], invalidate: vi.fn() },
    allToolComponents: [],
    allSlashCommandComponents: [],
    allSystemReminderComponents: [],
    allShellComponents: [],
    ui: { requestRender: vi.fn() } as unknown as TUIState['ui'],
    ...overrides,
  } as unknown as TUIState;
}

function createQueueContext(state: TUIState, overrides: Partial<EventHandlerContext> = {}): EventHandlerContext {
  return {
    state,
    showInfo: vi.fn(),
    showError: vi.fn(),
    showFormattedError: vi.fn(),
    updateStatusLine: vi.fn(),
    notify: vi.fn(),
    handleSlashCommand: vi.fn().mockResolvedValue(true),
    addUserMessage: vi.fn(),
    addChildBeforeFollowUps: vi.fn(),
    fireMessage: vi.fn(),
    queueFollowUpMessage: vi.fn(),
    renderExistingMessages: vi.fn(),
    renderCompletedTasksInline: vi.fn(),
    renderClearedTasksInline: vi.fn(),
    refreshModelAuthStatus: vi.fn(),
    ...overrides,
  };
}

describe('MastraTUI queueing', () => {
  beforeEach(() => {
    mocks.addUserMessage.mockReset();
    mocks.showInfo.mockReset();
    mocks.showError.mockReset();
  });

  it('sends editor submissions as signals instead of resolving input while the harness is running', async () => {
    const editor = {
      onSubmit: undefined as ((text: string) => void) | undefined,
      addToHistory: vi.fn(),
      setText: vi.fn(),
    };
    const state = {
      editor,
      harness: { isRunning: vi.fn(() => true) },
      pendingSlashCommands: [],
      pendingQueuedActions: [],
      pendingFollowUpMessages: [],
      pendingImages: [],
      ui: { requestRender: vi.fn() },
      chatContainer: {},
      followUpComponents: [],
    };

    const tui = Object.create(MastraTUI.prototype) as {
      state: typeof state;
      getUserInput: () => Promise<string>;
      queueFollowUpMessage: (text: string) => void;
      signalMessage: (text: string) => void;
    };
    tui.state = state;
    tui.queueFollowUpMessage = vi.fn();
    tui.signalMessage = vi.fn();

    const pendingInput = tui.getUserInput();
    editor.onSubmit?.('queued follow-up');

    expect(editor.addToHistory).toHaveBeenCalledWith('queued follow-up');
    expect(editor.setText).toHaveBeenCalledWith('');
    expect(tui.signalMessage).toHaveBeenCalledWith('queued follow-up');
    expect(tui.queueFollowUpMessage).not.toHaveBeenCalled();

    const resolution = await Promise.race([
      pendingInput.then(value => ({ resolved: true as const, value })),
      Promise.resolve({ resolved: false as const, value: undefined }),
    ]);
    expect(resolution).toEqual({ resolved: false, value: undefined });
  });

  it('keeps signal messages pending after sendSignal accepts until the stream echoes them', async () => {
    const sendSignal = vi
      .fn()
      .mockReturnValue({ id: 'signal-1', accepted: Promise.resolve({ accepted: true, runId: 'run-1' }) });
    const state = createQueueState({
      harness: {
        sendSignal,
        isCurrentThreadStreamActive: () => true,
        getCurrentRunId: () => null,
        getDisplayState: () => ({ isRunning: true }),
      } as unknown as TUIState['harness'],
      chatContainer: new Container(),
    });
    const tui = Object.create(MastraTUI.prototype) as {
      state: TUIState;
      signalMessage: (text: string) => void;
    };
    tui.state = state;

    tui.signalMessage('stay pending');
    await Promise.resolve();

    expect(sendSignal).toHaveBeenCalledWith({ content: 'stay pending' });
    expect(state.pendingSignalMessageComponentsById.has('signal-1')).toBe(true);
    expect(state.chatContainer.children).toHaveLength(1);
    expect(mocks.addUserMessage).not.toHaveBeenCalled();
  });

  it('renders idle signal messages directly instead of pending them', async () => {
    const sendSignal = vi
      .fn()
      .mockReturnValue({ id: 'signal-idle-1', accepted: Promise.resolve({ accepted: true, runId: 'run-1' }) });
    const state = createQueueState({
      harness: {
        sendSignal,
        isCurrentThreadStreamActive: () => false,
        getCurrentRunId: () => null,
        getDisplayState: () => ({ isRunning: false }),
      } as unknown as TUIState['harness'],
      chatContainer: new Container(),
    });
    const tui = Object.create(MastraTUI.prototype) as {
      state: TUIState;
      signalMessage: (text: string) => void;
    };
    tui.state = state;

    tui.signalMessage('render directly');
    await Promise.resolve();

    expect(sendSignal).toHaveBeenCalledWith({ content: 'render directly' });
    expect(state.pendingSignalMessageComponentsById.has('signal-idle-1')).toBe(false);
    expect(state.chatContainer.children).toHaveLength(0);
    expect(mocks.addUserMessage).toHaveBeenCalledWith(state, {
      id: 'signal-idle-1',
      role: 'user',
      content: [{ type: 'text', text: 'render directly' }],
      createdAt: expect.any(Date),
    });
  });

  it('queues follow-up messages with images in FIFO order metadata', () => {
    const tui = Object.create(MastraTUI.prototype) as {
      state: any;
      queueFollowUpMessage: (text: string) => void;
    };
    tui.state = {
      pendingSlashCommands: [],
      pendingQueuedActions: [],
      pendingFollowUpMessages: [],
      pendingImages: [{ data: 'img-1', mimeType: 'image/png' }],
      ui: { requestRender: vi.fn() },
      chatContainer: {},
      followUpComponents: [],
    };

    tui.queueFollowUpMessage('review this [image]');
    tui.queueFollowUpMessage('/help');
    tui.queueFollowUpMessage('second message');

    expect(tui.state.pendingQueuedActions).toEqual(['message', 'slash', 'message']);
    expect(tui.state.pendingFollowUpMessages).toEqual([
      { content: 'review this', images: [{ data: 'img-1', mimeType: 'image/png' }] },
      { content: 'second message', images: undefined },
    ]);
    expect(tui.state.pendingSlashCommands).toEqual(['/help']);
    expect(tui.state.ui.requestRender).toHaveBeenCalledTimes(3);
  });

  it('drains queued messages and slash commands in FIFO order on agent end', async () => {
    const state = createQueueState({
      pendingQueuedActions: ['message', 'slash', 'message'],
      pendingFollowUpMessages: [{ content: 'first' }, { content: 'third' }],
      pendingSlashCommands: ['/second'],
    });
    const ctx = createQueueContext(state);

    handleAgentEnd(ctx);
    expect(ctx.addUserMessage).toHaveBeenCalledWith({
      id: expect.stringMatching(/^user-/),
      role: 'user',
      content: [{ type: 'text', text: 'first' }],
      createdAt: expect.any(Date),
    });
    expect(ctx.fireMessage).toHaveBeenCalledWith('first', undefined);
    expect(ctx.handleSlashCommand).not.toHaveBeenCalled();

    handleAgentEnd(ctx);
    expect(ctx.handleSlashCommand).toHaveBeenCalledWith('/second');

    handleAgentEnd(ctx);
    expect(ctx.addUserMessage).toHaveBeenLastCalledWith({
      id: expect.stringMatching(/^user-/),
      role: 'user',
      content: [{ type: 'text', text: 'third' }],
      createdAt: expect.any(Date),
    });
    expect(ctx.fireMessage).toHaveBeenLastCalledWith('third', undefined);

    expect(state.pendingQueuedActions).toEqual([]);
    expect(state.pendingFollowUpMessages).toEqual([]);
    expect(state.pendingSlashCommands).toEqual([]);
    expect(ctx.updateStatusLine).toHaveBeenCalledTimes(6);
  });

  it('waits for harness-level follow-ups to finish before draining the local queue', () => {
    const state = createQueueState({
      harness: { getFollowUpCount: vi.fn(() => 1) } as any,
      pendingQueuedActions: ['message'],
      pendingFollowUpMessages: [{ content: 'queued' }],
    });
    const ctx = createQueueContext(state);

    handleAgentEnd(ctx);

    expect(ctx.fireMessage).not.toHaveBeenCalled();
    expect(state.pendingQueuedActions).toEqual(['message']);
    expect(state.pendingFollowUpMessages).toEqual([{ content: 'queued' }]);
  });
});

describe('consumePendingImages', () => {
  it('supports image-only submissions', () => {
    expect(consumePendingImages('[image] ', [{ data: 'img', mimeType: 'image/png' }])).toEqual({
      content: '',
      images: [{ data: 'img', mimeType: 'image/png' }],
    });
  });
});
