import type { MastraDBMessage } from '../message-list';
import type { DurableAgentSignal } from './types';

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeXmlAttribute(value: string): string {
  return escapeXml(value).replaceAll('"', '&quot;');
}

export function signalToMessage(signal: DurableAgentSignal): MastraDBMessage {
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
        ? signal.contents
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
