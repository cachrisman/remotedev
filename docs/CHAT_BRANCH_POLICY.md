# Chat ↔ Branch Policy (Branch-only Isolation) — Canon

## Status
**Canon for vNext** (post v0.16).

## Context

RemoteDev already has a single-controller model (controllerEpoch) and a persistent “session” unit with a well-defined lifecycle (IDLE/RUNNING/AWAITING_APPROVAL/DISCONNECTED)  [PLAN.md](PLAN.md). RemoteDev also persists history in SQLite (`sessions`, `transcript`, `audit_log`, `client_errors`)  [USER_GUIDE.md](USER_GUIDE.md).

This document defines how we map **Chats** to **Git branches** while keeping the existing “session” abstraction.

---

## Definitions

### Project
A filesystem directory that is a Git repo (a workingDir value). No additional config in v1.

### Chat
A long-lived unit of interaction that is:
- transcript + agent memory (future)
- resumable
- one-at-a-time interactive but may run long tasks

**Implementation note:** In v1, *Chat == existing Session* (same persistence + state machine), extended with Git metadata.

---

## Goals

1. Multiple chats can exist per project (repo).
2. Switching chats/branches is safe and predictable.
3. A chat can be resumed later and “knows” its branch context.
4. Branch-only isolation (no worktrees/clones) remains safe enough for single-agent usage.
5. Timeout-based “auto-pause” produces a clean repo state that allows future work without surprises.

---

## Non-goals (v1)

- Worktrees/containers per chat
- Multi-agent true concurrency safety (we still build guardrails, but no parallel execution guarantee)
- “Frozen” reproducibility snapshots

---

## Core Invariant: Repo Safe State

Because branch-only isolation shares a single working directory, the system enforces a **safe state** invariant whenever we:
- activate/resume a chat
- switch chats
- switch branches
- auto-pause a chat

### Safe State (v1)
Repo is safe iff:
- no unstaged tracked changes
- no staged changes
- no **untracked-but-not-ignored** files

Ignored files (build output, node_modules, etc.) do not block.

---

## Chat Lifecycle (v1 extension)

We keep RemoteDev’s existing session states and add two “meta” states:
- ACTIVE (interactive / ready) — maps to existing IDLE
- RUNNING — existing RUNNING
- PAUSED — new (idle timeout)
- ARCHIVED — new (manual)

RemoteDev’s existing states remain authoritative for execution and reconnect logic  [PLAN.md](PLAN.md).

---

## Branch Ownership Model: Exclusive Lease

Each chat has:
- `primaryBranch` (unique, created at chat creation)
- `currentBranch` (may change during chat)

Rules:
1. A branch may be “leased” by at most one chat in ACTIVE/RUNNING state.
2. PAUSED chats release the lease *after checkpoint completes*.
3. ARCHIVED chats have no lease.

---

## Branch Naming

Primary branch format (deterministic + readable):
- `chat/YYYYMMDD/<shortId>-<slug>`

Example:
- `chat/20260310/3f2a9c-fix-auth-spinner`

---

## Checkpointing (Timeout → PAUSED)

### What is a checkpoint?
A checkpoint is an automatic action that makes the repo “safe” so the chat can be paused and later work can proceed without cross-chat contamination.

### When does it run?
On ACTIVE → PAUSED transition (e.g., 12 hours idle).

### Checkpoint algorithm

1. Detect repo state:
   - unstaged tracked changes
   - staged changes
   - untracked-but-not-ignored files

2. If repo already safe → do nothing.

3. Else attempt **auto-commit**:
   - `git add -A` (includes untracked-but-not-ignored)
   - `git commit -m "checkpoint(chat:<chatId>) <ISO8601>"`

4. Risk guardrail: if risky, do **stash** instead:
   - stash includes untracked: `git stash push -u -m "checkpoint(chat:<chatId>) <ISO8601>"`

“Risky” means any of:
- changed file matches sensitive patterns (e.g. `.env`, `*.pem`, `*.key`, `id_rsa`, etc.)
- too many changed files (threshold: 200)
- commit fails for any reason (then fallback to stash)

### Git hooks
We do not rely on hooks in v1. Auto-commit runs normally (no special hook handling).

### Persistence
Store checkpoint metadata on the chat:
- `checkpointType`: `none | commit | stash`
- `checkpointRef`: commit SHA or stash ref
- `checkpointAt`: timestamp

Also write an audit_log entry.

---

## Switching Chats

Switching chats is gated by Safe State:
- If repo is not safe, UI must force a remediation choice:
  1) Commit
  2) Stash (includes untracked)
  3) Discard (dangerous)
  4) If only untracked ignored: allow continue (informational)

After remediation, checkout target chat’s `currentBranch` and resume.

---

## Switching Branches (within a chat)

Branch switching is allowed.

Rule:
- Must satisfy Safe State (or remediate) before switching branches.

On successful switch:
- update chat `currentBranch`
- write audit_log entry

---

## UI / UX Requirements (minimal v1)

In the header, always show:
- Project path (workingDir)
- Chat name
- currentBranch
- state (ACTIVE/RUNNING/PAUSED/ARCHIVED)

When gating is required, present a modal with:
- summary of dirty state (staged/unstaged/untracked-not-ignored counts)
- the remediation options (Commit/Stash/Discard)

---

## Database changes (SQLite)

RemoteDev already persists sessions & transcript  [USER_GUIDE.md](USER_GUIDE.md).

We extend `sessions` with new columns (names illustrative):
- `project_path` TEXT
- `chat_status` TEXT  -- ACTIVE/RUNNING/PAUSED/ARCHIVED (or reuse existing state with mapping)
- `primary_branch` TEXT
- `current_branch` TEXT
- `last_activity_at` INTEGER
- `paused_at` INTEGER NULL
- `archived_at` INTEGER NULL
- `checkpoint_type` TEXT NULL
- `checkpoint_ref` TEXT NULL
- `checkpoint_at` INTEGER NULL

Optional (nice):
- `git_checkpoints` table for history (chat_id, type, ref, ts, summary)

---

## Protocol changes (WS)

RemoteDev already supports create_session, resume_session, etc.  [PLAN.md](PLAN.md)

v1 implementation path:
- Keep existing message types for minimal churn.
- Extend `state_sync` payload to include git/chat metadata.
- Add new C→S messages for multi-chat:
  - `list_chats { projectPath }`
  - `create_chat { projectPath, name }`
  - `switch_chat { chatId }`
  - `archive_chat { chatId }`
  - `switch_branch { branchName }` (optional; could be done as a tool call but we want gating)

All mutating messages remain controllerEpoch-gated like existing behavior  [PLAN.md](PLAN.md).

---

## Logging / Auditing

For every checkpoint/switch/branch change:
- write `audit_log` row (event + detail)  [USER_GUIDE.md](USER_GUIDE.md)
- optionally write a transcript system message (helps later “agents analyze yesterday”)

---

## Test plan additions

Add manual tests to `docs/TEST_PROCEDURES.md`:
1. Create chat → verify branch created and checked out.
2. Make unstaged change → switch chat → gating modal appears.
3. Choose stash → verify clean → switch succeeds.
4. Idle timeout → verify checkpoint commit or stash created.
5. Resume chat after pause → branch restored.
6. Untracked ignored files do not block.