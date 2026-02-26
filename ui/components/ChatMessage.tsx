'use client';

import type { BridgeMsg } from '../lib/protocol';

export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number;
  type?: string;
}

interface ChatMessageProps {
  entry: ChatEntry;
}

export function ChatMessage({ entry }: ChatMessageProps) {
  const isUser = entry.role === 'user';
  const isSystem = entry.role === 'system';

  if (isSystem) {
    return (
      <div className="flex justify-center px-4 py-1">
        <span className="text-xs text-gray-500 italic">{entry.content}</span>
      </div>
    );
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} px-4 py-2`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
          isUser
            ? 'bg-blue-600 text-white rounded-br-sm'
            : 'bg-gray-800 text-gray-100 rounded-bl-sm'
        }`}
      >
        <pre className="whitespace-pre-wrap break-words font-sans">{entry.content}</pre>
      </div>
    </div>
  );
}

/**
 * Convert a bridge output payload to displayable text.
 */
export function payloadToText(payload: Record<string, unknown>): string | null {
  const type = payload.type as string | undefined;

  if (type === 'text' || type === 'raw_stdout' || type === 'stderr') {
    return (payload.text as string) || null;
  }

  if (type === 'result') {
    const result = payload.result;
    if (typeof result === 'string') return result;
    return JSON.stringify(result, null, 2);
  }

  // Stream-JSON assistant message
  if (payload.type === 'assistant') {
    const content = payload.content as unknown[];
    if (!Array.isArray(content)) return null;
    const texts: string[] = [];
    for (const block of content) {
      if (typeof block === 'object' && block !== null) {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          texts.push(b.text);
        }
      }
    }
    return texts.join('') || null;
  }

  return null;
}
