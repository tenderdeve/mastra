import { describe, expect, it, vi } from 'vitest';

const settingsMock = vi.hoisted(() => ({
  loadSettings: vi.fn(() => ({
    models: {
      goalJudgeModel: 'openai/gpt-5.5',
      goalMaxTurns: 50,
    },
  })),
  saveSettings: vi.fn(),
}));

vi.mock('../../../onboarding/settings.js', () => settingsMock);

import { DEFAULT_MAX_TURNS } from '../../goal-manager.js';
import { createGoalReminderMessage, handleGoalCommand } from '../goal.js';

describe('createGoalReminderMessage', () => {
  it('creates a canonical goal system reminder for chat history', () => {
    const message = createGoalReminderMessage(
      'goal-1',
      'Finish <the> task & verify it',
      DEFAULT_MAX_TURNS,
      'openai/gpt-5.5',
    );

    expect(message).toMatchObject({
      id: 'goal-goal-1',
      role: 'user',
      content: [
        {
          type: 'system_reminder',
          reminderType: 'goal',
          message: 'Finish <the> task & verify it',
          goalMaxTurns: DEFAULT_MAX_TURNS,
          judgeModelId: 'openai/gpt-5.5',
        },
      ],
    });
  });
});

describe('handleGoalCommand', () => {
  it('creates the pending new thread before saving a new goal', async () => {
    let currentThreadId = 'loaded-thread';
    const goal = {
      id: 'goal-1',
      objective: 'finish the task',
      status: 'active',
      turnsUsed: 0,
      maxTurns: 50,
      judgeModelId: 'openai/gpt-5.5',
    };
    const goalManager = {
      setGoal: vi.fn(() => goal),
      persistOnNextThreadCreate: vi.fn(),
      saveToThread: vi.fn(),
    };
    const createThread = vi.fn(async () => {
      currentThreadId = 'new-thread';
    });
    const sendMessage = vi.fn();
    const ctx = {
      state: {
        pendingNewThread: true,
        goalManager,
        harness: {
          createThread,
          getCurrentThreadId: vi.fn(() => currentThreadId),
          sendMessage,
        },
      },
      addUserMessage: vi.fn(),
      showError: vi.fn(),
    } as any;

    await handleGoalCommand(ctx, ['finish', 'the', 'task']);

    expect(createThread).toHaveBeenCalledTimes(1);
    expect(ctx.state.pendingNewThread).toBe(false);
    expect(goalManager.saveToThread).toHaveBeenCalledTimes(1);
    expect(createThread.mock.invocationCallOrder[0]).toBeLessThan(goalManager.saveToThread.mock.invocationCallOrder[0]);
    expect(goalManager.persistOnNextThreadCreate).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith({
      content: '<system-reminder type="goal">finish the task</system-reminder>',
    });
  });

  it('does not resume a completed goal', async () => {
    const goalManager = {
      getGoal: vi.fn(() => ({
        id: 'goal-1',
        objective: 'finish the task',
        status: 'done',
        turnsUsed: 2,
        maxTurns: DEFAULT_MAX_TURNS,
        judgeModelId: 'openai/gpt-5.5',
      })),
      resume: vi.fn(),
      saveToThread: vi.fn(),
    };
    const sendMessage = vi.fn();
    const showInfo = vi.fn();
    const ctx = {
      state: {
        goalManager,
        harness: { sendMessage },
      },
      showInfo,
    } as any;

    await handleGoalCommand(ctx, ['resume']);

    expect(showInfo).toHaveBeenCalledWith('Goal is already done. Use /goal <text> to set a new goal.');
    expect(goalManager.resume).not.toHaveBeenCalled();
    expect(goalManager.saveToThread).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
