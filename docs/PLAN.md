> **This document is the authoritative project specification for RemoteDev v0.16, February 2026.**

# RemoteDev — Project Specification v0.16

> **Authoritative project specification — February 2026.**

## Problem Statement

There's no native way to send a natural language instruction from an iPhone and have it execute against a local dev environment on a Mac. The Claude iOS app is chat-only — no filesystem, no terminal, no code access. This project builds that bridge.

## Solution

```
iPhone Safari → Next.js UI (HTTPS, mac.tailnet-name.ts.net:7000)
                     ↓ GET /api/token → { wsAuth: HMAC(BRIDGE_AUTH_TOKEN, nonce+ts) }
iPhone Safari → Bridge Server (WSS, mac.tailnet-name.ts.net:7001)
                     ↓ { type: "authenticate", payload: { wsAuth, clientSecret } }
                     ↓ { type: "authenticated", payload: { controllerEpoch } }
                     ↓ { type: "state_sync", payload: { state, seq, ... } }
                     ↓ claude -p --output-format stream-json
                     ↓ buffered NDJSON framer → approval FSM → phone
```

## Security Model

**Layer 1 — Tailscale device ACLs (network boundary)**
Only your iPhone's Tailscale device can reach ports 7000 and 7001. Primary network perimeter.

**Layer 2 — Static client secret (defense in depth)**
32-byte hex secret in macOS Keychain + iPhone Safari password manager. Required in every `authenticate` message. Never logged.

**Layer 3 — HMAC WS assertion (replaces raw token exposure)**
`GET /api/token` returns `{ wsAuth: HMAC(BRIDGE_AUTH_TOKEN, nonce + ts) }`. The bridge validates the HMAC, checks `ts` is within 30s, and verifies `nonce` has not been seen before (nonce stored in LRU cache for 30s). The browser never receives the raw bridge token. Eliminates XSS/copy-paste/shoulder-surfing exposure and replay attacks. `/api/token` route is `export const dynamic = 'force-dynamic'` to guarantee fresh nonce+ts on every request.

**Layer 4 — Controller epoch token (SessionManager-scoped)**
On successful `authenticate`, bridge mints a `controllerEpoch` UUID and stores it in `SessionManager` (global, bound to the active controller connection — not per-session). All mutating messages must include the current epoch. Stale tabs receive `bridge_warning { subtype: 'stale_epoch' }` followed by `ws.close(4403)`.

**Layer 5 — Tool execution boundary**
`workingDir` validated against `ALLOWED_ROOTS` at session creation. Tool input paths validated via ancestor-based `fs.realpathSync()`. No `shell: true`. Explicit argv.

**Bash threat model:** The approval gate defends against *accidents and unintended commands*, not prompt injection. The UI requires typing "APPROVE" to confirm any Bash tool call.

**Brute-force protection:** 5 failures/IP → 60s lockout. 4003-from-stale-assertion does NOT increment counter.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Startup checks:                                                             │
│  ├─ Cert: warn 14/7/3 days; refuse <24h or expired                         │
│  ├─ claude --version logged; CLAUDE_MIN_VERSION enforced                    │
│  ├─ Disk: warn if < 500MB                                                   │
│  ├─ ALLOWED_ROOTS realpathSync'd                                            │
│  ├─ SQLite open + WAL mode; retention pruning (transcript + audit_log)      │
│  ├─ Global process traps installed                                          │
│  └─ Orphan scan: kill any stray claude processes from prior crash           │
│                                                                              │
│  /api/token → { wsAuth: HMAC(BRIDGE_AUTH_TOKEN, nonce+ts) }                │
│  Bridge validates HMAC; browser never sees raw BRIDGE_AUTH_TOKEN            │
│                                                                              │
│  WSS connections:                                                           │
│  ├─ Per-IP unauthenticated limit (10); per-socket isAuthed flag            │
│  ├─ 5s auth timeout; 5 failures → 60s IP lockout                           │
│  ├─ authenticate { wsAuth, clientSecret } → both validated                 │
│  ├─ On success: mint controllerEpoch UUID; return in authenticated         │
│  ├─ All mutating messages require valid controllerEpoch                    │
│  └─ state_sync after auth                                                   │
│                                                                              │
│  Session states: IDLE | RUNNING | AWAITING_APPROVAL | DISCONNECTED         │
│                                                                              │
│  Key disconnect/reconnect invariants:                                       │
│  ├─ onDisconnect(): save preDisconnectState; start TTL timer if AWAITING   │
│  ├─ onReconnect(): restore from preDisconnectState; check TTL              │
│  └─ Backpressure: if ws.bufferedAmount high >30s → warn; >60s → ws.close  │
│       (1011) but session RUNNING; client reconnects via gap recovery        │
│                                                                              │
│  Session teardown: endSession(reason) — single idempotent path             │
│  Global traps: exit/SIGTERM/SIGINT/uncaughtException → killAllSessions()   │
│  ⚠ Cannot trap: SIGKILL, OOM kill, power loss, kernel panic               │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

- **`preDisconnectState` and no auto-deny on disconnect** — `onDisconnect()` does NOT auto-deny. Instead saves `this.preDisconnectState = this.state` and preserves `this.pendingApproval` intact. TTL expiry timer started in `onDisconnect()` fires deny only while DISCONNECTED. This preserves user intent on cellular drops.

- **Path validation tail uses `path.relative()` not string slicing** — After finding the nearest existing ancestor and calling `realpathSync()`, the non-existent tail is computed as `path.relative(ancestorLexical, candidateLexical)` then joined onto `resolvedAncestor`. Symlink-length-safe.

- **HMAC assertion replaces raw token** — Browser never sees `BRIDGE_AUTH_TOKEN`. `wsAuth` is time-limited and nonce-bound — interception cannot construct a new token.

- **controllerEpoch is SessionManager-scoped, not per-session** — Stored in `SessionManager.currentEpoch`. Stale tabs get `ws.close(4403)` — hard disconnect, not silent drop.

- **Backpressure: drop connection not session** — At 60s buffer-paused, `ws.close(1011)` is called but `endSession()` is not. Heartbeat timer cleared before close. Session stays RUNNING. Client reconnects and gap recovery delivers buffered output.

- **4003 token desync recovery** — `useWebSocket` detects 4003, clears cached assertion, re-fetches from `/api/token`, retries. Bridge treats stale-assertion 4003 as distinct from wrong-secret 4003 — does NOT increment IP lockout counter.

- **Offline transcript budget per-session-total** — `offlineTranscriptBytes` resets only in `endSession()`, not in `onDisconnect()`. Multiple disconnect windows count against the same 50MB cap.

- **Parse error degraded mode** — After 5 consecutive parse errors: `bridge_warning { subtype: 'parse_degraded' }` + stream raw stdout. Raw lines written to transcript as `type='raw_stdout'` (1000 lines/1MB cap). At 20 raw non-JSON lines: `endSession('parse_fatal')`.

- **Orphan scan uses REMOTEDEV_SESSION_ID** — All spawned claude subprocesses receive `REMOTEDEV_SESSION_ID=<sessionId>` in env. Scan reads `/proc/<pid>/environ` (Linux) or `ps -E` (macOS). Processes younger than 10 seconds are skipped.

- **WAL checkpoint: PASSIVE mode + non-blocking** — `PASSIVE` mode moves WAL frames without exclusive lock. Scheduled via `setImmediate` after `endSession()`. Rate-limited: at most once every 5 minutes. Defers if active sessions remain.

## Protocol Specification

### Message Envelope

```json
{
  "v": 1,
  "type": "event_name",
  "seq": 42,
  "sessionId": "uuid | null",
  "rootMessageId": "uuid | null",
  "controllerEpoch": "uuid | null",
  "messageId": "uuid",
  "ts": 1700000000000,
  "payload": { }
}
```

### WS Events

| Direction | Event | Purpose |
|---|---|---|
| C→S | `authenticate` | `{ wsAuth, nonce, ts, clientSecret }` |
| C→S | `create_session` | `{ name, workingDir, controllerEpoch }` |
| C→S | `input` | `{ instruction, messageId, controllerEpoch }` — mints rootMessageId |
| C→S | `stop` | `{ controllerEpoch }` |
| C→S | `approval_response` | `{ requestId, decision, controllerEpoch }` |
| C→S | `resume_session` | `{ sessionId, controllerEpoch }` |
| C→S | `ping` | `{ lastAck: seq }` |
| C→S | `client_error` | `{ rootMessageId, error, context }` |
| S→C | `authenticated` | `{ controllerEpoch }` |
| S→C | `state_sync` | Authoritative state; UI overwrites entirely |
| S→C | `output` | Streaming NDJSON (seq, rootMessageId) |
| S→C | `session_busy` | |
| S→C | `resync_required` | `{ fromSeq, currentSeq, persistenceDegraded }` |
| S→C | `transcript_chunk` | |
| S→C | `transcript_complete` | `{ truncated: bool }` |
| S→C | `bridge_warning` | `{ subtype: 'client_slow' \| 'parse_degraded' \| 'persistence_degraded' \| 'offline_budget_exceeded' \| 'stale_epoch' }` |
| S→C | `exit` | `{ reason }` |
| S→C | `error` | `{ message, subtype }` |
| S→C | `pong` | `{ seq }` |

### Session Lifecycle

```
IDLE
  └─ create_session + start_claude → RUNNING
       ├─ control_request → AWAITING_APPROVAL
       │    ├─ approved/denied/TTL expiry → RUNNING
       │    └─ ws.close / heartbeat timeout → DISCONNECTED (approval preserved)
       ├─ stop → endSession('stop')
       ├─ proc.close → endSession('proc_exit:code')
       ├─ backpressure >60s → ws.close(1011); session stays RUNNING
       └─ ws.close / heartbeat timeout → DISCONNECTED

DISCONNECTED (proc may be running; all callbacks guarded by if (this.destroyed) return)
  ├─ output buffered to ring + SQLite (per-session-total 50MB budget)
  ├─ reconnect + auth + resume_session → restore preDisconnectState
  └─ 5min no stdout → endSession('orphan')
```

## Phases

| # | Phase | Key Output | Status |
|---|---|---|---|
| 0 | TLS + Tailscale + Client Secret | iOS Safari trusts WSS; two-layer auth ready | ⬜ Not Started |
| 1a | Minimal live loop — auth, spawn, NDJSON, approval, stop, SQLite | End-to-end on tailnet iOS Safari | ⬜ Not Started |
| 1b | Resilience — DISCONNECTED, gap recovery, WAL, orphan scan, backpressure | Full production-grade bridge | ⬜ Not Started |
| 2 | Next.js Chat UI | Usable chat on phone | ⬜ Not Started |
| 3 | Polish & UX — transcript history, diff viewer, project switcher, dark mode | Production-ready app | ⬜ Not Started |

## Constraints & Assumptions

- Claude Pro subscription required
- Tailscale + `tailscale cert` + tailnet domain required
- Node.js 20+; `jq`; `re2` npm package
- Single controller at a time
- Mac sleep managed by per-session `caffeinate -i`
- Bash tool execution cannot be sandboxed; approval gate + "type APPROVE" is enforcement
- Global process traps do not cover SIGKILL/OOM/power loss

## Success Criteria

- From iPhone: *"add a loading spinner to the dashboard"* → correct file changes on Mac
- `./bin/reload` while phone connected → phone auto-recovers via 4003 token refresh; IP lockout NOT triggered
- Bash approval requires typing "APPROVE"; wrong string blocks
- AWAITING_APPROVAL correctly restored on reconnect (preDisconnectState preserved)
- Stale-tab command → `bridge_warning stale_epoch`; `ws.close(4403)`
- Slow cellular → bridge_warning at 30s; ws.close(1011) at 60s; session survives; gap recovery
- Symlink traversal → ancestor realpathSync + path.relative() catches it
- Bridge crash → killAllSessions; orphan scan catches remainder within 5min
- WAL checkpoint runs after last session ends; WAL file bounded
- All v0.13 success criteria remain in effect
