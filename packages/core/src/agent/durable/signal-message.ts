import type { MastraDBMessage } from '../message-list';
import type { DurableAgentSignal } from './types';

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeXmlAttribute(value: string): string {
  return escapeXml(value).replaceAll('"', '&quot;');
}

function signalUsername(signal: DurableAgentSignal): string | undefined {
  return signal.type === 'user-message' && typeof signal.username === 'string' ? signal.username : undefined;
}

function signalFiles(signal: DurableAgentSignal): Array<{ data: string; mediaType: string; filename?: string }> {
  const files = signal.metadata?.files;
  if (!Array.isArray(files)) return [];
  return files.filter(
    (file): file is { data: string; mediaType: string; filename?: string } =>
      !!file &&
      typeof file === 'object' &&
      typeof (file as any).data === 'string' &&
      typeof (file as any).mediaType === 'string' &&
      ((file as any).filename === undefined || typeof (file as any).filename === 'string'),
  );
}

export function signalToUserMessageStreamChunk(signal: DurableAgentSignal): unknown | undefined {
  if (signal.type !== 'user-message') return undefined;
  const username = signalUsername(signal);
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: signal.contents }];
  for (const file of signalFiles(signal)) {
    if (file.mediaType.startsWith('image/')) {
      content.push({ type: 'image', data: file.data, mimeType: file.mediaType });
    } else {
      content.push({ type: 'file', data: file.data, mediaType: file.mediaType, filename: file.filename });
    }
  }
  return {
    type: 'data-user-message',
    data: {
      message: {
        id: signal.id ?? `user-${Date.now()}`,
        role: 'user',
        content,
        createdAt: signal.createdAt ? new Date(signal.createdAt) : new Date(),
        metadata: { source: 'durable-signal', ...(username ? { username } : {}) },
      },
    },
  };
}

export function signalToMessage(signal: DurableAgentSignal): MastraDBMessage {
  const username = signalUsername(signal);
  const contentMetadata =
    signal.type === 'system-reminder'
      ? { systemReminder: { type: 'agent-signal', signalType: signal.type, ...signal.metadata } }
      : signal.type === 'user-message'
        ? undefined
        : { agentSignal: { type: signal.type, ...signal.metadata } };

  const contents =
    signal.type === 'system-reminder'
      ? `<system-reminder type="agent-signal">${escapeXml(signal.contents)}</system-reminder>`
      : signal.type === 'user-message'
        ? username
          ? `<user name="${escapeXmlAttribute(username)}">\n${escapeXml(signal.contents)}\n</user>`
          : signal.contents
        : `<agent-signal type="${escapeXmlAttribute(signal.type)}">${escapeXml(signal.contents)}</agent-signal>`;

  return {
    id: signal.id ?? `signal-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role: 'user',
    content: {
      format: 2,
      parts: [{ type: 'text', text: contents }],
      ...(contentMetadata ? { metadata: contentMetadata } : {}),
    },
    createdAt: signal.createdAt ? new Date(signal.createdAt) : new Date(),
  };
}
