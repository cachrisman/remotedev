import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

// ──────────────────────────────────────────────────────────────────────────
// Base envelope

export const BridgeMsgSchema = z.object({
  v: z.number(),
  type: z.string(),
  seq: z.number().nullable(),
  sessionId: z.string().nullable(),
  rootMessageId: z.string().nullable(),
  messageId: z.string(),
  ts: z.number(),
  payload: z.record(z.unknown()).nullable(),
  controllerEpoch: z.string().nullable(),
});

export type BridgeMsg = z.infer<typeof BridgeMsgSchema>;

// ──────────────────────────────────────────────────────────────────────────
// Payload schemas

export const StateSyncPayloadSchema = z.object({
  /** Optional: bridge sends "projects-only" state_sync (e.g. list_projects, add_project) without state. Consumers must guard. */
  state: z.enum(['IDLE', 'RUNNING', 'AWAITING_APPROVAL', 'DISCONNECTED']).optional(),
  sessionId: z.string().optional(),
  seq: z.number().optional(),
  lastAck: z.number().optional(),
  pendingApproval: z.object({
    requestId: z.string(),
    data: z.record(z.unknown()),
    expiresAt: z.number(),
  }).nullable().optional(),
  parseDegraded: z.boolean().optional(),
  persistenceDegraded: z.boolean().optional(),
  // Chat-branch policy
  projects: z.array(z.object({
    project_path: z.string(),
    created_at: z.number().optional(),
    last_used_at: z.number().nullable().optional(),
  })).optional(),
  activeProjectPath: z.string().nullable().optional(),
  activeChatId: z.string().nullable().optional(),
  currentBranch: z.string().optional(),
  chats: z.array(z.object({
    id: z.string(),
    name: z.string().optional(),
    working_dir: z.string().optional(),
    state: z.string().optional(),
    project_path: z.string().optional(),
    chat_status: z.string().optional(),
    primary_branch: z.string().optional(),
    current_branch: z.string().optional(),
    last_activity_at: z.number().optional(),
    paused_at: z.number().nullable().optional(),
    archived_at: z.number().nullable().optional(),
    created_at: z.number().optional(),
  })).optional(),
}).passthrough();

export type StateSyncPayload = z.infer<typeof StateSyncPayloadSchema>;

export interface GatingRequiredPayload {
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  stagedFiles?: string[];
  unstagedFiles?: string[];
  untrackedNotIgnoredFiles?: string[];
  truncated?: boolean;
}

export interface RemediateResultPayload {
  safe: boolean;
  stagedCount?: number;
  unstagedCount?: number;
  untrackedCount?: number;
  truncated?: boolean;
}

export const OutputPayloadSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
}).passthrough();

export const BridgeWarningPayloadSchema = z.object({
  subtype: z.string(),
}).passthrough();

export const ControlRequestPayloadSchema = z.object({
  type: z.literal('control_request'),
  requestId: z.string(),
  data: z.record(z.unknown()),
  expiresAt: z.number(),
});

// ──────────────────────────────────────────────────────────────────────────
// Session state

export type SessionState = 'IDLE' | 'RUNNING' | 'AWAITING_APPROVAL' | 'DISCONNECTED';

export interface PendingApproval {
  requestId: string;
  data: Record<string, unknown>;
  expiresAt: number;
}

export interface SessionInfo {
  sessionId: string;
  state: SessionState;
  seq: number;
  lastAck: number;
  pendingApproval: PendingApproval | null;
  parseDegraded: boolean;
  persistenceDegraded: boolean;
}
