import { Button, toast } from '@mastra/playground-ui';
import { useFormContext, useWatch } from 'react-hook-form';
import { useParams } from 'react-router';
import type { AgentBuilderEditFormValues } from '../../schemas';
import { SlackIcon } from './slack-icon';
import {
  useConnectChannel,
  useDisconnectChannel,
  useChannelInstallations,
  useChannelPlatforms,
} from '@/domains/agents/hooks/use-channels';
import { usePermissions } from '@/domains/auth/hooks/use-permissions';

export function PublishToSlackButton() {
  const { id } = useParams<{ id: string }>();
  const { control } = useFormContext<AgentBuilderEditFormValues>();
  const name = useWatch({ control, name: 'name' });
  const description = useWatch({ control, name: 'description' });

  const { data: platforms } = useChannelPlatforms();
  const { hasPermission } = usePermissions();
  const slackAvailable = platforms?.some(p => p.id === 'slack') ?? false;
  const canWriteChannels = hasPermission('channels:write');

  const { mutate: connect, isPending: isConnecting } = useConnectChannel('slack');
  const { mutate: disconnect, isPending: isDisconnecting } = useDisconnectChannel('slack');
  const { data: installations } = useChannelInstallations('slack', id ?? '');
  const isConnected = installations?.some(i => i.status === 'active');

  const handleConnect = () => {
    if (!id) {
      toast.error('Save the agent first before publishing to Slack');
      return;
    }

    connect(
      { agentId: id, options: { name, description } },
      {
        onSuccess: result => {
          switch (result.type) {
            case 'oauth':
              window.location.href = result.authorizationUrl;
              break;
            case 'deep_link': {
              const popup = window.open(result.url, '_blank', 'noopener,noreferrer');
              if (!popup) {
                toast.error('Popup blocked — please allow popups and try again');
              }
              break;
            }
            case 'immediate':
              toast.success('Published to Slack');
              break;
          }
        },
        onError: (err: Error & { body?: { error?: string } }) => {
          toast.error(err.body?.error || err.message || 'Failed to publish to Slack');
        },
      },
    );
  };

  const handleDisconnect = () => {
    if (!id) return;
    disconnect(id, {
      onError: (err: Error & { body?: { error?: string } }) => {
        toast.error(err.body?.error || err.message || 'Failed to remove from Slack');
      },
    });
  };

  if (!slackAvailable || !canWriteChannels) {
    return null;
  }

  if (isConnected) {
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={handleDisconnect}
        disabled={isDisconnecting}
        data-testid="agent-builder-publish-slack"
      >
        <SlackIcon className="h-4 w-4" />
        {isDisconnecting ? 'Removing…' : 'Remove from Slack'}
      </Button>
    );
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={handleConnect}
      disabled={isConnecting || !id}
      data-testid="agent-builder-publish-slack"
    >
      <SlackIcon className="h-4 w-4" />
      {isConnecting ? 'Publishing…' : 'Publish to Slack'}
    </Button>
  );
}
