'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { z } from 'zod';
import { useWebSocket } from '../hooks/useWebSocket';
import { ApprovalModal } from '../components/ApprovalModal';
import { ChatMessage, type ChatEntry, payloadToText } from '../components/ChatMessage';
import { WarningBanner } from '../components/WarningBanner';
import {
  type BridgeMsg,
  type SessionInfo,
  type PendingApproval,
  StateSyncPayloadSchema,
} from '../lib/protocol';
import crypto from 'crypto';

const UI_BUILD_VERSION = process.env.UI_BUILD_VERSION || 'unknown';
const DEFAULT_SESSION_NAME = 'main';
const WORKING_DIR = process.env.NEXT_PUBLIC_WORKING_DIR || '';

// ──────────────────────────────────────────────────────────────────────────
// State

interface AppState {
  sessionId: string | null;
  sessionState: SessionInfo['state'];
  messages: ChatEntry[];
  warnings: string[];
  pendingApproval: PendingApproval | null;
  parseDegraded: boolean;
  persistenceDegraded: boolean;
}

type AppAction =
  | { type: 'SET_SESSION'; sessionId: string; state: SessionInfo['state'] }
  | { type: 'SET_STATE'; state: SessionInfo['state']; pendingApproval?: PendingApproval | null }
  | { type: 'ADD_MESSAGE'; entry: ChatEntry }
  | { type: 'ADD_WARNING'; subtype: string }
  | { type: 'DISMISS_WARNING'; subtype: string }
  | { type: 'SET_APPROVAL'; approval: PendingApproval | null }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'SET_DEGRADED'; parse?: boolean; persistence?: boolean };

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_SESSION':
      return { ...state, sessionId: action.sessionId, sessionState: action.state };
    case 'SET_STATE':
      return {
        ...state,
        sessionState: action.state,
        pendingApproval: action.pendingApproval !== undefined
          ? action.pendingApproval
          : (action.state !== 'AWAITING_APPROVAL' ? null : state.pendingApproval),
      };
    case 'ADD_MESSAGE':
      return { ...state, messages: [...state.messages, action.entry] };
    case 'ADD_WARNING':
      if (state.warnings.includes(action.subtype)) return state;
      return { ...state, warnings: [...state.warnings, action.subtype] };
    case 'DISMISS_WARNING':
      return { ...state, warnings: state.warnings.filter(w => w !== action.subtype) };
    case 'SET_APPROVAL':
      return { ...state, pendingApproval: action.approval };
    case 'CLEAR_MESSAGES':
      return { ...state, messages: [] };
    case 'SET_DEGRADED':
      return {
        ...state,
        parseDegraded: action.parse ?? state.parseDegraded,
        persistenceDegraded: action.persistence ?? state.persistenceDegraded,
      };
    default:
      return state;
  }
}

const initialState: AppState = {
  sessionId: null,
  sessionState: 'IDLE',
  messages: [],
  warnings: [],
  pendingApproval: null,
  parseDegraded: false,
  persistenceDegraded: false,
};

// ──────────────────────────────────────────────────────────────────────────
// Component

export default function Home() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [input, setInput] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const rootMessageIdRef = useRef<string | null>(null);
  const epochRef = useRef<string | null>(null);

  const sendClientError = useCallback((
    error: string,
    context: string,
    rootMessageId: string | null
  ) => {
    send({
      type: 'client_error',
      sessionId: state.sessionId,
      payload: { rootMessageId, error, context, uiBuildVersion: UI_BUILD_VERSION },
    } as Parameters<typeof send>[0]);
  }, [state.sessionId]);

  const handleMessage = useCallback((msg: BridgeMsg) => {
    try {
      switch (msg.type) {
        case 'authenticated':
          setIsConnected(true);
          // Create session if we don't have one
          if (!state.sessionId) {
            const messageId = crypto.randomUUID();
            send({
              type: 'create_session',
              payload: { name: DEFAULT_SESSION_NAME, workingDir: WORKING_DIR },
            } as Parameters<typeof send>[0]);
          }
          break;

        case 'state_sync': {
          let payload;
          try {
            payload = StateSyncPayloadSchema.parse(msg.payload);
          } catch (err) {
            sendClientError(
              String(err),
              'state_sync_parse_failed',
              msg.rootMessageId,
            );
            return;
          }

          if (msg.sessionId && !state.sessionId) {
            dispatch({ type: 'SET_SESSION', sessionId: msg.sessionId, state: payload.state });
          } else {
            dispatch({
              type: 'SET_STATE',
              state: payload.state,
              pendingApproval: payload.pendingApproval || null,
            });
          }

          if (payload.parseDegraded) dispatch({ type: 'SET_DEGRADED', parse: true });
          if (payload.persistenceDegraded) dispatch({ type: 'SET_DEGRADED', persistence: true });
          break;
        }

        case 'output': {
          const payload = msg.payload;
          if (!payload) break;

          // Handle control_request
          if (payload.type === 'control_request') {
            const approval: PendingApproval = {
              requestId: payload.requestId as string,
              data: payload.data as Record<string, unknown>,
              expiresAt: payload.expiresAt as number,
            };
            dispatch({ type: 'SET_APPROVAL', approval });
            break;
          }

          const text = payloadToText(payload);
          if (text) {
            dispatch({
              type: 'ADD_MESSAGE',
              entry: {
                id: msg.messageId,
                role: 'assistant',
                content: text,
                ts: msg.ts,
                type: payload.type as string,
              },
            });
          }
          break;
        }

        case 'bridge_warning': {
          const subtype = (msg.payload?.subtype as string) || 'unknown';
          dispatch({ type: 'ADD_WARNING', subtype });
          if (subtype === 'parse_degraded') dispatch({ type: 'SET_DEGRADED', parse: true });
          if (subtype === 'persistence_degraded') dispatch({ type: 'SET_DEGRADED', persistence: true });
          break;
        }

        case 'exit': {
          const reason = (msg.payload?.reason as string) || 'unknown';
          dispatch({
            type: 'ADD_MESSAGE',
            entry: {
              id: msg.messageId,
              role: 'system',
              content: `Session ended: ${reason}`,
              ts: msg.ts,
            },
          });
          dispatch({ type: 'SET_STATE', state: 'IDLE' });
          break;
        }

        case 'session_busy':
          dispatch({
            type: 'ADD_MESSAGE',
            entry: {
              id: msg.messageId,
              role: 'system',
              content: 'Session is busy. Please wait for the current task to complete.',
              ts: msg.ts,
            },
          });
          break;

        case 'transcript_chunk':
          // Display transcript chunks during gap recovery
          if (msg.payload) {
            const text = payloadToText(msg.payload);
            if (text) {
              dispatch({
                type: 'ADD_MESSAGE',
                entry: {
                  id: msg.messageId,
                  role: 'assistant',
                  content: text,
                  ts: msg.ts,
                },
              });
            }
          }
          break;

        case 'resync_required':
          dispatch({
            type: 'ADD_MESSAGE',
            entry: {
              id: msg.messageId,
              role: 'system',
              content: 'Reconnected — replaying missed output...',
              ts: msg.ts,
            },
          });
          dispatch({ type: 'CLEAR_MESSAGES' });
          break;

        case 'error':
          dispatch({
            type: 'ADD_MESSAGE',
            entry: {
              id: msg.messageId,
              role: 'system',
              content: `Error: ${msg.payload?.message || 'unknown'}`,
              ts: msg.ts,
            },
          });
          break;
      }
    } catch (err) {
      // React error boundary equivalent
      sendClientError(
        String(err),
        `message_handler_${msg.type}`,
        msg.rootMessageId,
      );
    }
  }, [state.sessionId, sendClientError]);

  const { connectionState, send, controllerEpoch } = useWebSocket({
    onMessage: handleMessage,
    sessionId: state.sessionId,
  });

  useEffect(() => {
    epochRef.current = controllerEpoch;
  }, [controllerEpoch]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.messages]);

  const handleSend = useCallback(() => {
    const instruction = input.trim();
    if (!instruction || state.sessionState !== 'IDLE') return;

    const messageId = crypto.randomUUID();
    rootMessageIdRef.current = messageId;

    dispatch({
      type: 'ADD_MESSAGE',
      entry: {
        id: messageId,
        role: 'user',
        content: instruction,
        ts: Date.now(),
      },
    });

    send({
      type: 'input',
      sessionId: state.sessionId,
      payload: { instruction, messageId },
    } as Parameters<typeof send>[0]);

    setInput('');
  }, [input, state.sessionState, state.sessionId, send]);

  const handleApprove = useCallback(() => {
    if (!state.pendingApproval) return;
    send({
      type: 'approval_response',
      sessionId: state.sessionId,
      payload: { requestId: state.pendingApproval.requestId, decision: 'approve' },
    } as Parameters<typeof send>[0]);
    dispatch({ type: 'SET_APPROVAL', approval: null });
  }, [state.pendingApproval, state.sessionId, send]);

  const handleDeny = useCallback(() => {
    if (!state.pendingApproval) return;
    send({
      type: 'approval_response',
      sessionId: state.sessionId,
      payload: { requestId: state.pendingApproval.requestId, decision: 'deny' },
    } as Parameters<typeof send>[0]);
    dispatch({ type: 'SET_APPROVAL', approval: null });
  }, [state.pendingApproval, state.sessionId, send]);

  const handleStop = useCallback(() => {
    send({
      type: 'stop',
      sessionId: state.sessionId,
      payload: {},
    } as Parameters<typeof send>[0]);
  }, [state.sessionId, send]);

  const statusColor = {
    connected: 'bg-green-500',
    authenticating: 'bg-yellow-500',
    connecting: 'bg-yellow-500',
    disconnected: 'bg-gray-500',
    error: 'bg-red-500',
  }[connectionState] || 'bg-gray-500';

  const sessionStatus = {
    IDLE: 'Ready',
    RUNNING: 'Running...',
    AWAITING_APPROVAL: 'Waiting for approval',
    DISCONNECTED: 'Reconnecting...',
  }[state.sessionState] || state.sessionState;

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <div className="flex items-center gap-3">
          <div className={`w-2.5 h-2.5 rounded-full ${statusColor}`} />
          <span className="font-semibold text-white">RemoteDev</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-400">{sessionStatus}</span>
          {(state.sessionState === 'RUNNING' || state.sessionState === 'AWAITING_APPROVAL') && (
            <button
              onClick={handleStop}
              className="text-xs bg-red-900/50 text-red-300 border border-red-800 px-3 py-1 rounded-lg hover:bg-red-900 transition-colors"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      {/* Degraded banners */}
      {state.parseDegraded && (
        <div className="px-4 py-2">
          <WarningBanner
            subtype="parse_degraded"
            onDismiss={() => dispatch({ type: 'DISMISS_WARNING', subtype: 'parse_degraded' })}
          />
        </div>
      )}
      {state.persistenceDegraded && (
        <div className="px-4 py-2">
          <WarningBanner
            subtype="persistence_degraded"
            onDismiss={() => dispatch({ type: 'DISMISS_WARNING', subtype: 'persistence_degraded' })}
          />
        </div>
      )}

      {/* Warning banners */}
      {state.warnings.filter(w => w !== 'parse_degraded' && w !== 'persistence_degraded').map(w => (
        <div key={w} className="px-4 py-1">
          <WarningBanner
            subtype={w}
            onDismiss={() => dispatch({ type: 'DISMISS_WARNING', subtype: w })}
          />
        </div>
      ))}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto py-4 space-y-1">
        {state.messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center px-8 space-y-3">
            <p className="text-gray-400 text-base">
              {connectionState === 'connected' || connectionState === 'authenticating'
                ? 'Send an instruction to start'
                : `Connecting${connectionState === 'error' ? ' (retrying...)' : '...'}`}
            </p>
          </div>
        )}
        {state.messages.map(entry => (
          <ChatMessage key={entry.id} entry={entry} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-800 px-4 py-3">
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={
              state.sessionState === 'IDLE'
                ? 'Enter an instruction...'
                : 'Waiting for task to complete...'
            }
            disabled={state.sessionState !== 'IDLE'}
            rows={1}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 resize-none focus:outline-none focus:border-blue-500 disabled:opacity-50 min-h-[48px] max-h-40"
            style={{ fieldSizing: 'content' } as React.CSSProperties}
          />
          <button
            onClick={handleSend}
            disabled={state.sessionState !== 'IDLE' || !input.trim()}
            className="bg-blue-600 text-white px-4 py-3 rounded-xl font-medium hover:bg-blue-500 active:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
          >
            Send
          </button>
        </div>
      </div>

      {/* Approval modal */}
      {state.pendingApproval && (
        <ApprovalModal
          approval={state.pendingApproval}
          onApprove={handleApprove}
          onDeny={handleDeny}
        />
      )}
    </div>
  );
}
