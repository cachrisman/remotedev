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
  state: z.enum(['IDLE', 'RUNNING', 'AWAITING_APPROVAL', 'DISCONNECTED']),
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
});

export type StateSyncPayload = z.infer<typeof StateSyncPayloadSchema>;

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
