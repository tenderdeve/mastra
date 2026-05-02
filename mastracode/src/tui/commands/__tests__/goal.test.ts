import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_MAX_TURNS } from '../../goal-manager.js';
import { createGoalReminderMessage, handleGoalCommand } from '../goal.js';

describe('createGoalReminderMessage', () => {
  it('creates a canonical goal system reminder for chat history', () => {
    const message = createGoalReminderMessage('goal-1', 'Finish <the> task & verify it', DEFAULT_MAX_TURNS, 'openai/gpt-5.5');

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
