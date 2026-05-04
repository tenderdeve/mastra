import type { Task } from '@mastra/core/a2a';
import type { IMastraLogger } from '@mastra/core/logger';
import type { InMemoryPushNotificationStore } from './push-notification-store';

export const DEFAULT_PUSH_NOTIFICATION_TOKEN_HEADER = 'X-A2A-Notification-Token';

export class DefaultPushNotificationSender {
  constructor(
    private readonly pushNotificationStore: InMemoryPushNotificationStore,
    private readonly options: {
      timeout?: number;
      tokenHeaderName?: string;
      fetch?: typeof fetch;
    } = {},
  ) {}

  async sendNotifications({
    agentId,
    task,
    logger,
  }: {
    agentId: string;
    task: Task;
    logger?: IMastraLogger;
  }): Promise<void> {
    const configs = this.pushNotificationStore.list({
      agentId,
      params: { id: task.id },
    });

    if (configs.length === 0) {
      return;
    }

    await Promise.allSettled(
      configs.map(async config => {
        const headers = new Headers({
          'content-type': 'application/json',
        });

        if (config.pushNotificationConfig.token) {
          headers.set(
            this.options.tokenHeaderName ?? DEFAULT_PUSH_NOTIFICATION_TOKEN_HEADER,
            config.pushNotificationConfig.token,
          );
        }

        const auth = config.pushNotificationConfig.authentication;
        if (auth?.credentials) {
          if (auth.schemes.includes('Bearer')) {
            headers.set('authorization', `Bearer ${auth.credentials}`);
          } else if (auth.schemes.includes('Basic')) {
            headers.set('authorization', `Basic ${auth.credentials}`);
          }
        }

        const response = await (this.options.fetch ?? fetch)(config.pushNotificationConfig.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(task),
          signal:
            typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(this.options.timeout ?? 5_000) : undefined,
        });

        if (!response.ok) {
          throw new Error(`Push notification failed with status ${response.status} ${response.statusText}`);
        }
      }),
    ).then(results => {
      for (const result of results) {
        if (result.status === 'rejected') {
          logger?.error('Failed to deliver A2A push notification', result.reason);
        }
      }
    });
  }
}
