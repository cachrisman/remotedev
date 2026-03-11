'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useWebSocket, type UseWebSocketReturn } from '../hooks/useWebSocket';
import { ApprovalModal } from '../components/ApprovalModal';
import { ChatMessage, type ChatEntry, payloadToText } from '../components/ChatMessage';
import { WarningBanner } from '../components/WarningBanner';
import {
  type BridgeMsg,
  type SessionInfo,
  type PendingApproval,
  StateSyncPayloadSchema,
} from '../lib/protocol';

const UI_BUILD_VERSION = process.env.UI_BUILD_VERSION || 'unknown';
const DEFAULT_SESSION_NAME = 'main';

/** Normalize branch name for comparison (strip refs/heads/, refs/remotes/origin/, origin/ so UI and server formats match). */
function normalizeBranch(branch: string | undefined | null): string {
  if (branch == null || typeof branch !== 'string') return '';
  return branch
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/origin\//, '')
    .replace(/^origin\//, '');
}

// ──────────────────────────────────────────────────────────────────────────
// State

interface ProjectInfo {
  project_path: string;
  created_at?: number;
  last_used_at?: number | null;
}

interface ChatInfo {
  id: string;
  name?: string;
  chat_status?: string;
  primary_branch?: string;
  current_branch?: string;
  created_at?: number;
}

interface AppState {
  sessionId: string | null;
  sessionState: SessionInfo['state'];
  messages: ChatEntry[];
  warnings: string[];
  pendingApproval: PendingApproval | null;
  parseDegraded: boolean;
  persistenceDegraded: boolean;
  projects: ProjectInfo[];
  activeProjectPath: string | null;
  chats: ChatInfo[];
  activeChatId: string | null;
  currentBranch: string | null;
  gatingRequired: { chatId: string | null; stagedCount: number; unstagedCount: number; untrackedCount: number; stagedFiles?: string[]; unstagedFiles?: string[]; untrackedNotIgnoredFiles?: string[]; truncated?: boolean; remediateError?: string } | null;
  /** Set when we send switch_chat/switch_branch so we can retry after remediate */
  pendingGatingAction: { type: 'switch_chat'; chatId: string } | { type: 'switch_branch'; branchName: string } | null;
  addProjectError: string | null;
}

type AppAction =
  | { type: 'SET_SESSION'; sessionId: string; state: SessionInfo['state'] }
  | { type: 'CLEAR_SESSION' }
  | { type: 'SET_STATE'; state: SessionInfo['state']; pendingApproval?: PendingApproval | null }
  | { type: 'SET_PROJECTS'; projects: ProjectInfo[]; activeProjectPath?: string | null; chats?: ChatInfo[]; activeChatId?: string | null; currentBranch?: string | null }
  | { type: 'ADD_MESSAGE'; entry: ChatEntry }
  | { type: 'ADD_WARNING'; subtype: string }
  | { type: 'DISMISS_WARNING'; subtype: string }
  | { type: 'SET_APPROVAL'; approval: PendingApproval | null }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'SET_DEGRADED'; parse?: boolean; persistence?: boolean }
  | { type: 'SET_GATING'; payload: AppState['gatingRequired'] }
  | { type: 'SET_PENDING_GATING_ACTION'; action: AppState['pendingGatingAction'] }
  | { type: 'SET_ADD_PROJECT_ERROR'; error: string | null };

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_SESSION':
      return { ...state, sessionId: action.sessionId, sessionState: action.state };
    case 'CLEAR_SESSION':
      return { ...state, sessionId: null, sessionState: 'IDLE', messages: [] };
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
      return {
        ...state,
        warnings: state.warnings.filter(w => w !== action.subtype),
        parseDegraded: action.subtype === 'parse_degraded' ? false : state.parseDegraded,
        persistenceDegraded: action.subtype === 'persistence_degraded' ? false : state.persistenceDegraded,
      };
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
    case 'SET_PROJECTS':
      return {
        ...state,
        projects: action.projects ?? state.projects,
        activeProjectPath: action.activeProjectPath !== undefined ? action.activeProjectPath : state.activeProjectPath,
        chats: action.chats !== undefined ? action.chats : state.chats,
        activeChatId: action.activeChatId !== undefined ? action.activeChatId : state.activeChatId,
        currentBranch: action.currentBranch !== undefined ? action.currentBranch : state.currentBranch,
      };
    case 'SET_GATING':
      return { ...state, gatingRequired: action.payload };
    case 'SET_PENDING_GATING_ACTION':
      return { ...state, pendingGatingAction: action.action };
    case 'SET_ADD_PROJECT_ERROR':
      return { ...state, addProjectError: action.error };
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
  projects: [],
  activeProjectPath: null,
  chats: [],
  activeChatId: null,
  currentBranch: null,
  gatingRequired: null,
  pendingGatingAction: null,
  addProjectError: null,
};

function basename(p: string) {
  return p.replace(/\/$/, '').split('/').pop() ?? p;
}

// ──────────────────────────────────────────────────────────────────────────
// Component

export default function Home() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const rootMessageIdRef = useRef<string | null>(null);
  const stateRef = useRef<AppState>(initialState);

  // Runtime config fetched from token endpoint (allowedRoots, bridgeWsUrl)
  const [allowedRoots, setAllowedRoots] = useState<string[]>([]);
  const [selectedWorkingDir, setSelectedWorkingDir] = useState<string | null>(null);
  const selectedWorkingDirRef = useRef<string | null>(null);
  const pendingCreateRef = useRef(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const [addProjectPath, setAddProjectPath] = useState('');
  const [gatingRemediateMessage, setGatingRemediateMessage] = useState('');
  const [gatingDiscardConfirm, setGatingDiscardConfirm] = useState(false);
  const [showSwitchBranch, setShowSwitchBranch] = useState(false);
  const [switchBranchName, setSwitchBranchName] = useState('');
  /** When true, show projects/chats list even when a session is active (so user can switch chat). */
  const [showProjectsChatsView, setShowProjectsChatsView] = useState(false);

  // Stable ref to send so callbacks defined before useWebSocket can call it
  const sendRef = useRef<UseWebSocketReturn['send'] | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Fetch runtime config once on mount (allowedRoots for project picker)
  useEffect(() => {
    fetch('/api/token')
      .then(r => r.json())
      .then((data: { allowedRoots?: string[] }) => {
        const roots = data.allowedRoots ?? [];
        setAllowedRoots(roots);
        if (roots.length <= 1) {
          const dir = roots[0] ?? '';
          setSelectedWorkingDir(dir);
          selectedWorkingDirRef.current = dir;
          // If authentication already arrived before config loaded, create session now
          if (pendingCreateRef.current) {
            pendingCreateRef.current = false;
            sendRef.current?.({
              type: 'create_session',
              payload: { name: DEFAULT_SESSION_NAME, workingDir: dir },
            });
          }
        }
      })
      .catch(() => {});
  }, []);

  const handlePickProject = useCallback((dir: string) => {
    setSelectedWorkingDir(dir);
    selectedWorkingDirRef.current = dir;
    pendingCreateRef.current = false;
    sendRef.current?.({
      type: 'create_session',
      payload: { name: DEFAULT_SESSION_NAME, workingDir: dir },
    });
  }, []);

  const handleSelectProject = useCallback((projectPath: string) => {
    sendRef.current?.({
      type: 'select_project',
      payload: { projectPath },
    } as Parameters<NonNullable<typeof sendRef.current>>[0]);
  }, []);

  const handleAddProject = useCallback(() => {
    const path = addProjectPath.trim();
    if (!path) return;
    dispatch({ type: 'SET_ADD_PROJECT_ERROR', error: null });
    sendRef.current?.({
      type: 'add_project',
      payload: { projectPath: path },
    } as Parameters<NonNullable<typeof sendRef.current>>[0]);
    setAddProjectPath('');
    setShowAddProject(false);
  }, [addProjectPath]);

  const handleCreateChat = useCallback(() => {
    const projectPath = state.activeProjectPath;
    if (!projectPath) return;
    sendRef.current?.({
      type: 'create_chat',
      payload: { projectPath, name: 'New chat' },
    } as Parameters<NonNullable<typeof sendRef.current>>[0]);
  }, [state.activeProjectPath]);

  const handleSwitchChat = useCallback((chatId: string) => {
    dispatch({ type: 'SET_PENDING_GATING_ACTION', action: { type: 'switch_chat', chatId } });
    sendRef.current?.({
      type: 'switch_chat',
      payload: { chatId },
    } as Parameters<NonNullable<typeof sendRef.current>>[0]);
  }, []);

  const handleSwitchBranch = useCallback((branchName: string) => {
    dispatch({ type: 'SET_PENDING_GATING_ACTION', action: { type: 'switch_branch', branchName } });
    sendRef.current?.({
      type: 'switch_branch',
      payload: { branchName },
    } as Parameters<NonNullable<typeof sendRef.current>>[0]);
  }, []);

  const sendRemediate = useCallback((action: 'commit' | 'stash' | 'discard', message?: string) => {
    const g = state.gatingRequired;
    if (!g) return;
    sendRef.current?.({
      type: 'remediate',
      payload: { chatId: g.chatId, action, message: message?.trim() || undefined },
    } as Parameters<NonNullable<typeof sendRef.current>>[0]);
  }, [state.gatingRequired]);

  const dismissGating = useCallback(() => {
    dispatch({ type: 'SET_GATING', payload: null });
    dispatch({ type: 'SET_PENDING_GATING_ACTION', action: null });
    setGatingDiscardConfirm(false);
    setGatingRemediateMessage('');
  }, []);

  const sendClientError = useCallback((
    error: string,
    context: string,
    rootMessageId: string | null
  ) => {
    sendRef.current?.({
      type: 'client_error',
      sessionId: stateRef.current.sessionId,
      payload: { rootMessageId, error, context, uiBuildVersion: UI_BUILD_VERSION },
    } as Parameters<NonNullable<typeof sendRef.current>>[0]);
  }, []);

  const handleMessage = useCallback((msg: BridgeMsg) => {
    const currentState = stateRef.current;
    try {
      switch (msg.type) {
        case 'authenticated': {
          sendRef.current?.({ type: 'list_projects', payload: {} } as Parameters<NonNullable<typeof sendRef.current>>[0]);
          if (!currentState.sessionId) {
            const dir = selectedWorkingDirRef.current;
            if (dir !== null) {
              sendRef.current?.({
                type: 'create_session',
                payload: { name: DEFAULT_SESSION_NAME, workingDir: dir },
              });
            } else {
              pendingCreateRef.current = true;
            }
          }
          break;
        }

        case 'state_sync': {
          let payload;
          try {
            payload = StateSyncPayloadSchema.parse(msg.payload);
          } catch (err) {
            sendClientError(String(err), 'state_sync_parse_failed', msg.rootMessageId);
            return;
          }

          if (payload.projects !== undefined || payload.activeProjectPath !== undefined || payload.chats !== undefined || payload.activeChatId !== undefined || payload.currentBranch !== undefined) {
            dispatch({
              type: 'SET_PROJECTS',
              projects: payload.projects ?? currentState.projects,
              activeProjectPath: payload.activeProjectPath ?? null,
              chats: payload.chats ?? currentState.chats,
              activeChatId: payload.activeChatId ?? null,
              currentBranch: payload.currentBranch ?? null,
            });
            dispatch({ type: 'SET_ADD_PROJECT_ERROR', error: null });
          }
          const pending = currentState.pendingGatingAction;
          if (pending && payload.activeChatId !== undefined && pending.type === 'switch_chat' && payload.activeChatId === pending.chatId) {
            dispatch({ type: 'SET_PENDING_GATING_ACTION', action: null });
          }
          if (pending && payload.currentBranch !== undefined && pending.type === 'switch_branch' && normalizeBranch(payload.currentBranch) === normalizeBranch(pending.branchName)) {
            dispatch({ type: 'SET_PENDING_GATING_ACTION', action: null });
          }
          if (payload.state !== undefined) {
            const sid = msg.sessionId ?? (payload.sessionId as string | undefined);
            if (sid && !currentState.sessionId) {
              dispatch({ type: 'SET_SESSION', sessionId: sid, state: payload.state });
            } else {
              dispatch({
                type: 'SET_STATE',
                state: payload.state,
                pendingApproval: payload.pendingApproval || null,
              });
            }
            if (payload.sessionId !== undefined || payload.activeChatId !== undefined) setShowProjectsChatsView(false);
          }
          if (payload.parseDegraded) dispatch({ type: 'SET_DEGRADED', parse: true });
          if (payload.persistenceDegraded) dispatch({ type: 'SET_DEGRADED', persistence: true });
          break;
        }

        case 'gating_required': {
          const p = msg.payload as Record<string, unknown>;
          dispatch({
            type: 'SET_GATING',
            payload: {
              chatId: (p?.chatId as string | undefined) ?? null,
              stagedCount: (p?.stagedCount as number) ?? 0,
              unstagedCount: (p?.unstagedCount as number) ?? 0,
              untrackedCount: (p?.untrackedCount as number) ?? 0,
              stagedFiles: p?.stagedFiles as string[] | undefined,
              unstagedFiles: p?.unstagedFiles as string[] | undefined,
              untrackedNotIgnoredFiles: p?.untrackedNotIgnoredFiles as string[] | undefined,
              truncated: p?.truncated as boolean | undefined,
            },
          });
          break;
        }

        case 'remediate_result': {
          const p = msg.payload as Record<string, unknown>;
          if (p?.safe === true) {
            const action = currentState.pendingGatingAction;
            dispatch({ type: 'SET_GATING', payload: null });
            dispatch({ type: 'SET_PENDING_GATING_ACTION', action: null });
            if (action?.type === 'switch_chat') {
              sendRef.current?.({ type: 'switch_chat', payload: { chatId: action.chatId } } as Parameters<NonNullable<typeof sendRef.current>>[0]);
            } else if (action?.type === 'switch_branch') {
              sendRef.current?.({ type: 'switch_branch', payload: { branchName: action.branchName } } as Parameters<NonNullable<typeof sendRef.current>>[0]);
            }
          } else {
            const chatIdFromMsg = (msg.sessionId ?? p?.chatId) as string | undefined;
            dispatch({
              type: 'SET_GATING',
              payload: {
                chatId: typeof chatIdFromMsg === 'string' ? chatIdFromMsg : null,
                stagedCount: (p?.stagedCount as number) ?? 0,
                unstagedCount: (p?.unstagedCount as number) ?? 0,
                untrackedCount: (p?.untrackedCount as number) ?? 0,
                stagedFiles: p?.stagedFiles as string[] | undefined,
                unstagedFiles: p?.unstagedFiles as string[] | undefined,
                untrackedNotIgnoredFiles: p?.untrackedNotIgnoredFiles as string[] | undefined,
                truncated: (p?.truncated as boolean) ?? false,
                remediateError: (p?.message as string) || (p?.reason as string) || 'Still not safe — commit or stash did not clear all changes.',
              },
            });
          }
          break;
        }

        case 'output': {
          const payload = msg.payload;
          if (!payload) break;

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
            entry: { id: msg.messageId, role: 'system', content: `Session ended: ${reason}`, ts: msg.ts },
          });
          dispatch({ type: 'SET_STATE', state: 'IDLE' });
          break;
        }

        case 'session_busy':
          dispatch({
            type: 'ADD_MESSAGE',
            entry: { id: msg.messageId, role: 'system', content: 'Session is busy — wait for the current task to complete.', ts: msg.ts },
          });
          break;

        case 'transcript_chunk':
          if (msg.payload) {
            const text = payloadToText(msg.payload);
            if (text) {
              dispatch({
                type: 'ADD_MESSAGE',
                entry: { id: msg.messageId, role: 'assistant', content: text, ts: msg.ts },
              });
            }
          }
          break;

        case 'resync_required':
          dispatch({ type: 'CLEAR_MESSAGES' });
          dispatch({
            type: 'ADD_MESSAGE',
            entry: { id: msg.messageId, role: 'system', content: 'Reconnected — replaying missed output...', ts: msg.ts },
          });
          break;

        case 'error': {
          const errMsg = (msg.payload?.message as string) || 'unknown';
          const errorCode = (msg.payload?.subtype ?? msg.payload?.code ?? msg.payload?.reason) as string | undefined;
          if (errorCode && ['PATH_NOT_FOUND', 'NOT_WITHIN_ALLOWED_ROOTS', 'NOT_A_GIT_REPO'].includes(errorCode)) {
            dispatch({ type: 'SET_ADD_PROJECT_ERROR', error: errorCode });
            break;
          }
          if (errMsg === 'session_not_found') {
            dispatch({ type: 'CLEAR_SESSION' });
            const dir = selectedWorkingDirRef.current ?? '';
            sendRef.current?.({
              type: 'create_session',
              payload: { name: DEFAULT_SESSION_NAME, workingDir: dir },
            });
            break;
          }
          dispatch({
            type: 'ADD_MESSAGE',
            entry: { id: msg.messageId, role: 'system', content: `Error: ${errMsg}`, ts: msg.ts },
          });
          break;
        }
      }
    } catch (err) {
      sendClientError(String(err), `message_handler_${msg.type}`, msg.rootMessageId);
    }
  }, [sendClientError]);

  const { connectionState, send, controllerEpoch } = useWebSocket({
    onMessage: handleMessage,
    sessionId: state.sessionId,
  });

  // Keep sendRef current so callbacks above can always reach the latest send
  useEffect(() => { sendRef.current = send; }, [send]);

  // Auto-scroll to bottom on new messages
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
      entry: { id: messageId, role: 'user', content: instruction, ts: Date.now() },
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
  }[connectionState] ?? 'bg-gray-500';

  const sessionStatus = {
    IDLE: 'Ready',
    RUNNING: 'Running...',
    AWAITING_APPROVAL: 'Needs approval',
    DISCONNECTED: 'Reconnecting...',
  }[state.sessionState] ?? state.sessionState;

  const showProjectsAndChats = (connectionState === 'connected' || connectionState === 'authenticating') && allowedRoots.length > 1 && (!state.sessionId || showProjectsChatsView);

  return (
    // h-dvh = dynamic viewport height: shrinks/grows as Safari toolbar appears/disappears
    <div className="flex flex-col h-dvh max-w-2xl mx-auto">

      {/* Header: background fills through the Dynamic Island / notch via pt-safe */}
      <header className="flex-shrink-0 bg-gray-900 border-b border-gray-800 pt-safe">
        <div className="flex items-center justify-between px-4 py-2">
          {/* Left: identity + working dir */}
          <div className="flex items-center gap-2 min-w-0">
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColor}`} />
            <div className="min-w-0">
              <span className="font-semibold text-sm text-white">RemoteDev</span>
              {(state.activeProjectPath || selectedWorkingDir) && (
                <span className="ml-2 text-xs text-gray-500 truncate">
                  {basename(state.activeProjectPath || selectedWorkingDir || '')}
                </span>
              )}
              {state.currentBranch && (
                <button
                  type="button"
                  onClick={() => { setSwitchBranchName(state.currentBranch ?? ''); setShowSwitchBranch(true); }}
                  className="ml-2 text-xs text-blue-400 truncate hover:text-blue-300"
                  title="Switch branch"
                >
                  {state.currentBranch}
                </button>
              )}
            </div>
          </div>

          {/* Right: session state + stop */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {state.sessionId && allowedRoots.length > 1 && (
              <button
                type="button"
                onClick={() => setShowProjectsChatsView(prev => !prev)}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                {showProjectsChatsView ? 'Back to chat' : 'Chats'}
              </button>
            )}
            <span className="text-xs text-gray-400">{sessionStatus}</span>
            {(state.sessionState === 'RUNNING' || state.sessionState === 'AWAITING_APPROVAL') && (
              <button
                onClick={handleStop}
                className="text-xs bg-red-900/50 text-red-300 border border-red-800 px-3 py-1 rounded-lg active:bg-red-900 transition-colors"
              >
                Stop
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Degraded + warning banners */}
      {state.parseDegraded && (
        <div className="px-4 pt-2">
          <WarningBanner subtype="parse_degraded" onDismiss={() => dispatch({ type: 'DISMISS_WARNING', subtype: 'parse_degraded' })} />
        </div>
      )}
      {state.persistenceDegraded && (
        <div className="px-4 pt-2">
          <WarningBanner subtype="persistence_degraded" onDismiss={() => dispatch({ type: 'DISMISS_WARNING', subtype: 'persistence_degraded' })} />
        </div>
      )}
      {state.warnings
        .filter(w => w !== 'parse_degraded' && w !== 'persistence_degraded')
        .map(w => (
          <div key={w} className="px-4 pt-1">
            <WarningBanner subtype={w} onDismiss={() => dispatch({ type: 'DISMISS_WARNING', subtype: w })} />
          </div>
        ))}

      {/* Messages / projects & chats */}
      <div className="flex-1 overflow-y-auto">
        {showProjectsAndChats ? (
          <div className="flex flex-col p-4 gap-4">
            <section>
              <p className="text-gray-400 text-sm font-medium mb-2">Projects</p>
              <div className="space-y-1">
                {state.projects.map(p => (
                  <button
                    key={p.project_path}
                    onClick={() => handleSelectProject(p.project_path)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm ${state.activeProjectPath === p.project_path ? 'bg-blue-900/50 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                  >
                    {basename(p.project_path)}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setShowAddProject(true)}
                className="mt-2 text-sm text-blue-400 hover:text-blue-300"
              >
                Add project
              </button>
              {state.addProjectError && (
                <p className="mt-1 text-xs text-red-400">{state.addProjectError}</p>
              )}
            </section>
            {state.activeProjectPath && (
              <section>
                <p className="text-gray-400 text-sm font-medium mb-2">Chats</p>
                <div className="space-y-1">
                  {state.chats.map(c => (
                    <button
                      key={c.id}
                      onClick={() => handleSwitchChat(c.id)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-sm ${state.activeChatId === c.id ? 'bg-blue-900/50 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                    >
                      {c.name || c.id.slice(0, 8)} {c.current_branch && `(${c.current_branch})`}
                    </button>
                  ))}
                </div>
                <button
                  onClick={handleCreateChat}
                  className="mt-2 text-sm text-blue-400 hover:text-blue-300"
                >
                  New chat
                </button>
                {state.sessionId && (
                  <button
                    onClick={() => setShowProjectsChatsView(false)}
                    className="mt-3 text-sm text-gray-400 hover:text-gray-300"
                  >
                    Back to chat
                  </button>
                )}
              </section>
            )}
          </div>
        ) : (
          <div className="py-4 space-y-1">
            {state.messages.length === 0 && (
              <div className="flex flex-col items-center justify-center min-h-40 text-center px-8">
                <p className="text-gray-500 text-sm">
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
        )}
      </div>

      {/* Input: pb-safe keeps it above the home indicator */}
      <div className="flex-shrink-0 border-t border-gray-800 bg-gray-900 px-4 pt-3 pb-safe" style={{ paddingBottom: `max(env(safe-area-inset-bottom), 12px)` }}>
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
            disabled={state.sessionState !== 'IDLE' || showProjectsAndChats}
            rows={1}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 resize-none focus:outline-none focus:border-blue-500 disabled:opacity-50 min-h-[48px] max-h-40"
            style={{ fieldSizing: 'content' } as React.CSSProperties}
          />
          <button
            onClick={handleSend}
            disabled={state.sessionState !== 'IDLE' || !input.trim() || showProjectsAndChats}
            className="bg-blue-600 text-white px-4 py-3 rounded-xl font-medium active:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
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
      {state.gatingRequired && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-gray-900 rounded-xl shadow-xl max-w-md w-full max-h-[85vh] overflow-hidden flex flex-col">
            <div className="p-4 flex-shrink-0">
              <p className="text-white font-medium">Uncommitted changes</p>
              <p className="text-gray-400 text-sm mt-1">
                {state.gatingRequired.chatId ? 'Commit, stash, or discard changes to continue.' : 'Commit or stash in your repo, then try again.'}
              </p>
              {state.gatingRequired.remediateError && (
                <p className="text-amber-400 text-sm mt-2">{state.gatingRequired.remediateError}</p>
              )}
            </div>
            <div className="px-4 overflow-y-auto flex-1 min-h-0 text-sm">
              <p className="text-gray-400">
                Staged: {state.gatingRequired.stagedCount} · Unstaged: {state.gatingRequired.unstagedCount} · Untracked: {state.gatingRequired.untrackedCount}
                {state.gatingRequired.truncated && ' (list truncated)'}
              </p>
              {((state.gatingRequired.stagedFiles?.length ?? 0) + (state.gatingRequired.unstagedFiles?.length ?? 0) + (state.gatingRequired.untrackedNotIgnoredFiles?.length ?? 0)) > 0 && (
                <ul className="mt-2 space-y-0.5 text-gray-500 text-xs font-mono break-all">
                  {state.gatingRequired.stagedFiles?.slice(0, 30).map(f => <li key={f}>S: {f}</li>)}
                  {state.gatingRequired.unstagedFiles?.slice(0, 30).map(f => <li key={f}>U: {f}</li>)}
                  {state.gatingRequired.untrackedNotIgnoredFiles?.slice(0, 30).map(f => <li key={f}>?: {f}</li>)}
                </ul>
              )}
            </div>
            {!state.gatingRequired.chatId ? (
              <div className="p-4 flex justify-end border-t border-gray-800">
                <button onClick={dismissGating} className="px-3 py-1.5 text-sm text-gray-300 hover:text-white">Cancel</button>
              </div>
            ) : !gatingDiscardConfirm ? (
              <>
                <div className="px-4 py-2">
                  <input
                    type="text"
                    value={gatingRemediateMessage}
                    onChange={e => setGatingRemediateMessage(e.target.value)}
                    placeholder="Message (optional for commit/stash)"
                    className="w-full bg-gray-800 text-white rounded-lg px-3 py-2 text-sm border border-gray-700 focus:border-blue-500 outline-none"
                  />
                </div>
                <div className="p-4 flex flex-wrap gap-2 justify-end border-t border-gray-800">
                  <button onClick={dismissGating} className="px-3 py-1.5 text-sm text-gray-300 hover:text-white">Cancel</button>
                  <button onClick={() => sendRemediate('commit', gatingRemediateMessage)} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500">Commit</button>
                  <button onClick={() => sendRemediate('stash', gatingRemediateMessage)} className="px-3 py-1.5 text-sm bg-gray-600 text-white rounded-lg hover:bg-gray-500">Stash</button>
                  <button onClick={() => setGatingDiscardConfirm(true)} className="px-3 py-1.5 text-sm bg-red-900/60 text-red-300 rounded-lg hover:bg-red-900/80">Discard</button>
                </div>
              </>
            ) : (
              <div className="p-4 border-t border-gray-800">
                <p className="text-red-300 text-sm mb-2">Are you sure? Discard cannot be undone.</p>
                <div className="flex gap-2 justify-end">
                  <button onClick={() => setGatingDiscardConfirm(false)} className="px-3 py-1.5 text-sm text-gray-300 hover:text-white">Back</button>
                  <button onClick={() => { sendRemediate('discard'); setGatingDiscardConfirm(false); }} className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-500">Discard all</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {showSwitchBranch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-gray-900 rounded-xl shadow-xl max-w-md w-full p-4 flex flex-col gap-3">
            <p className="text-white font-medium">Switch branch</p>
            <input
              type="text"
              value={switchBranchName}
              onChange={e => setSwitchBranchName(e.target.value)}
              placeholder="branch name"
              className="bg-gray-800 text-white rounded-lg px-3 py-2 text-sm border border-gray-700 focus:border-blue-500 outline-none"
              autoFocus
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setShowSwitchBranch(false); setSwitchBranchName(''); }} className="px-3 py-1.5 text-sm text-gray-300 hover:text-white">Cancel</button>
              <button
                onClick={() => { if (switchBranchName.trim()) { handleSwitchBranch(switchBranchName.trim()); setShowSwitchBranch(false); setSwitchBranchName(''); } }}
                disabled={!switchBranchName.trim()}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50"
              >
                Switch
              </button>
            </div>
          </div>
        </div>
      )}
      {showAddProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-gray-900 rounded-xl shadow-xl max-w-md w-full p-4 flex flex-col gap-3">
            <p className="text-white font-medium">Add project</p>
            <p className="text-gray-400 text-sm">Enter the absolute path to a git repo under an allowed root.</p>
            <input
              type="text"
              value={addProjectPath}
              onChange={e => setAddProjectPath(e.target.value)}
              placeholder={allowedRoots[0] || '/path/to/project'}
              className="bg-gray-800 text-white rounded-lg px-3 py-2 text-sm border border-gray-700 focus:border-blue-500 outline-none"
              autoFocus
            />
            {state.addProjectError && (
              <p className="text-xs text-red-400">{state.addProjectError}</p>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setShowAddProject(false); setAddProjectPath(''); dispatch({ type: 'SET_ADD_PROJECT_ERROR', error: null }); }}
                className="px-3 py-1.5 text-sm text-gray-300 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={handleAddProject}
                disabled={!addProjectPath.trim()}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50 disabled:pointer-events-none"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
