import { Switch, Input, Entry, Skeleton, Txt, Button } from '@mastra/playground-ui';
import { useState, useEffect, useCallback } from 'react';
import { useHeartbeats, useSetHeartbeat, useDeleteHeartbeat } from '../../hooks/use-heartbeat';

interface AgentHeartbeatProps {
  agentId: string;
  threadId: string;
}

export function AgentHeartbeat({ agentId, threadId }: AgentHeartbeatProps) {
  const { data, isLoading } = useHeartbeats(agentId);
  const { mutateAsync: setHeartbeat, isPending: isSettingHeartbeat } = useSetHeartbeat(agentId);
  const { mutateAsync: deleteHeartbeat, isPending: isDeletingHeartbeat } = useDeleteHeartbeat(agentId);

  const isActive = data?.threadIds?.includes(threadId) ?? false;
  const isPending = isSettingHeartbeat || isDeletingHeartbeat;

  const [intervalMinutes, setIntervalMinutes] = useState('30');
  const [prompt, setPrompt] = useState('');

  // Reset form when thread changes
  useEffect(() => {
    setIntervalMinutes('30');
    setPrompt('');
  }, [threadId]);

  const handleToggle = useCallback(
    async (checked: boolean) => {
      if (checked) {
        const intervalMs = Math.max(1, Number(intervalMinutes) || 30) * 60_000;
        await setHeartbeat({
          threadId,
          enabled: true,
          intervalMs,
          ...(prompt ? { prompt } : {}),
        });
      } else {
        await deleteHeartbeat(threadId);
      }
    },
    [threadId, intervalMinutes, prompt, setHeartbeat, deleteHeartbeat],
  );

  const handleUpdate = useCallback(async () => {
    const intervalMs = Math.max(1, Number(intervalMinutes) || 30) * 60_000;
    await setHeartbeat({
      threadId,
      enabled: true,
      intervalMs,
      ...(prompt ? { prompt } : {}),
    });
  }, [threadId, intervalMinutes, prompt, setHeartbeat]);

  if (isLoading) {
    return (
      <div className="flex flex-col h-full p-4 gap-4">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      {/* Enable/Disable toggle */}
      <div className="p-4 border-b border-border1">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-neutral5">Thread Heartbeat</h3>
            <p className="text-xs text-neutral3 mt-1">Run periodic agent check-ins on this thread</p>
          </div>
          <Switch checked={isActive} onCheckedChange={handleToggle} disabled={isPending} />
        </div>
      </div>

      {/* Configuration */}
      <div className="p-4 space-y-4">
        <Entry label="Interval (minutes)">
          <Input
            type="number"
            size="sm"
            min={1}
            value={intervalMinutes}
            onChange={e => setIntervalMinutes(e.target.value)}
            placeholder="30"
            disabled={isPending}
          />
        </Entry>

        <Entry label="Heartbeat prompt (optional)">
          <textarea
            className="flex w-full rounded-md border border-border1 bg-transparent px-3 py-2 text-sm text-neutral6 placeholder:text-neutral2 focus:outline-none focus:ring-1 focus:ring-accent1 disabled:cursor-not-allowed disabled:opacity-50 min-h-[80px] resize-y"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="Check in on the conversation. If nothing needs attention, say nothing meaningful."
            disabled={isPending}
          />
        </Entry>

        {isActive && (
          <Button onClick={handleUpdate} disabled={isPending} className="w-full">
            {isPending ? 'Updating...' : 'Update Heartbeat'}
          </Button>
        )}
      </div>

      {/* Status */}
      {data?.threadIds && data.threadIds.length > 0 && (
        <div className="p-4 border-t border-border1">
          <Txt as="p" variant="ui-sm" className="text-neutral3">
            {data.threadIds.length} active heartbeat{data.threadIds.length !== 1 ? 's' : ''} on this agent
          </Txt>
        </div>
      )}
    </div>
  );
}
