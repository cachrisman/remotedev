# RemoteDev — Todo List

Status as of v0.16 initial implementation (February 2026).

**Legend:** ✅ Done · 🔄 In Progress / Immediate Next · ⬜ Not Started · ❌ Blocked / Known Gap

---

## ✅ Completed (Initial Implementation)

### Project Structure
- ✅ Monorepo with npm workspaces (`bridge-server/`, `ui/`)
- ✅ `package.json` root + workspace configs
- ✅ `.gitignore` (node_modules, .db files, .env files, .next/)
- ✅ `.env.example` with all documented variables
- ✅ MIT `LICENSE`
- ✅ `README.md` with installation and quick-start guide
- ✅ Ports changed from 3000/3001 → **7000/7001** to avoid conflicts with common dev servers

### Bridge Server Core
- ✅ `bridge-server/auth.js` — HMAC-SHA256 assertion validation, 30s TTL
- ✅ Nonce replay cache (LRU/Map with 30s TTL per entry)
- ✅ `clientSecret` constant-time compare (`crypto.timingSafeEqual`)
- ✅ Per-IP brute-force lockout: 5 failures → 60s
- ✅ 4003-from-stale-assertion exempt from lockout counter
- ✅ Per-IP unauthenticated connection limit (10)
- ✅ `bridge-server/session-manager.js` — global singleton
- ✅ `controllerEpoch` stored in `SessionManager` (not per-session) — per spec
- ✅ `mintEpoch()` / `validateEpoch()` / `getCurrentEpoch()`
- ✅ `setController()` / `releaseController()` / `hasActiveController()`
- ✅ `bridge-server/db.js` — `better-sqlite3` + WAL mode
- ✅ Schema: `sessions`, `transcript`, `audit_log`, `client_errors` tables
- ✅ 30-day retention pruning + `VACUUM` after pruning
- ✅ Batched writes (100ms / 50 events, recursive setTimeout)
- ✅ `persistenceDegraded` flag on write failure
- ✅ `bridge-server/wal.js` — PASSIVE WAL checkpoint
- ✅ Non-blocking via `setImmediate` after `endSession()`
- ✅ Rate-limited to once per 5 minutes
- ✅ Defers if active sessions remain
- ✅ `bridge-server/ndjson-framer.js` — fault-tolerant line framer
- ✅ 1MB max line size; truncation recovery; cross-chunk buffering
- ✅ `bridge-server/path-validator.js` — ancestor `realpathSync` + `path.relative()` tail
- ✅ Symlink-length-safe; handles non-existent paths
- ✅ `re2` with 50ms timeout fallback for ReDoS protection

### Bridge Session Lifecycle (`bridge-server/session.js`)
- ✅ States: `IDLE` / `RUNNING` / `AWAITING_APPROVAL` / `DISCONNECTED`
- ✅ `preDisconnectState` saved in `onDisconnect()` before overwrite
- ✅ **No auto-deny on disconnect** — approval preserved through disconnect
- ✅ TTL-expiry timer in `onDisconnect()` — denies only while `DISCONNECTED`
- ✅ `onReconnect()` restores `AWAITING_APPROVAL` within TTL
- ✅ Exactly-once `control_response` via `lastRespondedRequestId`
- ✅ Backpressure: 30s → `bridge_warning client_slow`; 60s → `ws.close(1011)` (session stays `RUNNING`)
- ✅ Heartbeat cleared before intentional `ws.close` (prevents spurious `DISCONNECTED`)
- ✅ Parse degraded mode: 5 errors → raw stream; 20 raw lines → `endSession('parse_fatal')`
- ✅ Raw stdout lines persisted as `type='raw_stdout'` (1000 lines / 1MB cap)
- ✅ Offline transcript budget: 50MB per-session-total, reset only in `endSession()`
- ✅ Ring buffer (200 entries) for gap recovery
- ✅ `endSession(reason)` — single idempotent teardown path
- ✅ `if (this.destroyed) return` guards in all async callbacks
- ✅ `SessionManager.remove(id)` + null large buffers on teardown
- ✅ `caffeinate -i` spawned per session; `SIGKILL`'d in `endSession()`

### Bridge Main Server (`bridge-server/index.js`)
- ✅ WSS server (HTTPS + WSS if TLS certs present; HTTP + WS for local dev)
- ✅ Per-IP unauthenticated limit (10); 5s auth timeout
- ✅ Protocol v1 envelope routing; v-mismatch → `ws.close(4400)`
- ✅ Controller epoch validation on all mutating C→S messages → `ws.close(4403)`
- ✅ All message handlers: `create_session`, `input`, `stop`, `approval_response`, `resume_session`, `ping`, `client_error`
- ✅ `resume_session` handles all four states correctly
- ✅ `client_error` persisted to SQLite (rate-limited 10/session)

### Startup & Operations
- ✅ `bridge-server/startup-checks.js` — cert expiry (14/7/3 day warnings; refuse <24h), claude version, disk space
- ✅ `bridge-server/orphan-scan.js` — `REMOTEDEV_SESSION_ID` detection; `/proc` on Linux, `ps -E` on macOS; skip <10s old; runs at startup + every 5 min
- ✅ Global process traps: `exit`, `SIGTERM`, `SIGINT`, `uncaughtException` → `killAllSessions()`
- ✅ `process.abort()` fallback if `killAllSessions()` throws
- ✅ `bridge-server/stub.js` — canned sequence stub for Phase 2 parallel UI development
- ✅ `ecosystem.config.js` — pm2 config for both processes

### Bin Scripts
- ✅ `bin/setup` — interactive Phase 0 (Tailscale, TLS, Keychain, ALLOWED_ROOTS)
- ✅ `bin/reload` — `pm2 restart --update-env` + readiness poll on port 7001
- ✅ `bin/test-tailnet` — automated + manual tailnet test suite; phase gate script

### Next.js UI
- ✅ `ui/app/api/token/route.ts` — `force-dynamic`, returns `{ wsAuth, nonce, ts }` only
- ✅ `ui/hooks/useWebSocket.ts`:
  - ✅ 4003 → clear cached token, re-fetch `/api/token`, retry (no lockout increment)
  - ✅ 1011 → immediate jittered reconnect (200–1000ms)
  - ✅ `controllerEpoch` included in all mutating messages
  - ✅ `visibilitychange` → reconnect immediately on tab focus
  - ✅ Periodic pings (20s) with `lastAck`
  - ✅ `v` mismatch → `ws.close(4400)`
- ✅ `ui/app/page.tsx` — full chat UI:
  - ✅ `state_sync` overwrites entirely (authoritative)
  - ✅ `resync_required` + `transcript_chunk` gap recovery rendering
  - ✅ `bridge_warning` → UI warning banners
  - ✅ `session_busy` → message shown
  - ✅ React error → `client_error { rootMessageId, error, context, uiBuildVersion }` sent back to bridge
- ✅ `ui/components/ApprovalModal.tsx` — Bash requires typing `"APPROVE"` exactly; TTL countdown
- ✅ `ui/components/ChatMessage.tsx` — message rendering, `payloadToText()` for all output types
- ✅ `ui/components/WarningBanner.tsx` — all `bridge_warning` subtypes mapped to human-readable strings
- ✅ `ui/lib/protocol.ts` — Zod schemas for all message types

### Unit Tests (Written — Not Yet Run)
- ✅ `test/auth.test.js` — HMAC validation, replay, IP lockout, stale-assertion exemption
- ✅ `test/db.test.js` — session CRUD, transcript batch, audit log, client errors
- ✅ `test/ndjson-framer.test.js` — framing, buffering, flush, error recovery
- ✅ `test/path-validator.test.js` — traversal, symlinks, ancestor validation
- ✅ `test/redos.test.js` — timing guarantee for `safeMatch()`
- ✅ `test/session-manager.test.js` — epoch lifecycle, controller tracking, `activeCount`
- ✅ `test/wal.test.js` — PASSIVE checkpoint, rate limiting

### Documentation
- ✅ `README.md` — installation, quick start, project structure, operations, security summary
- ✅ `docs/PLAN.md` — authoritative project specification
- ✅ `docs/USER_GUIDE.md` — detailed operational guide
- ✅ `docs/IMPLEMENTATION_LOG.md` — what was built and how
- ✅ `docs/TODO.md` — this file
- ✅ `docs/TEST_PROCEDURES.md` — test guide
- ✅ `CONTRIBUTING.md` — contributor guide
- ✅ `SECURITY.md` — security policy and disclosure

### Bug Fixes (During Review)
- ✅ `session-manager.js`: `activePids()` called `.filter()/.map()` on `MapIterator` — fixed by spreading to array first (`[...this.#sessions.values()]`)
- ✅ `test/path-validator.test.js`: TypeScript cast syntax `null as unknown as string` in a plain `.js` file — replaced with `null`

---

## 🔄 Immediate Next Steps (Before First Run)

These must be done before the servers can start:

1. **Install dependencies**
   ```bash
   cd bridge-server && npm install && cd ..
   cd ui && npm install && npm run build && cd ..
   ```

2. **Run unit tests** — verify all 7 suites pass
   ```bash
   cd bridge-server && node --test test/**/*.test.js
   ```
   Fix any failures before proceeding. See [docs/TEST_PROCEDURES.md](TEST_PROCEDURES.md) for known first-run issues.

3. **Add `ecosystem.config.local.js` to `.gitignore`** — this file is generated by `bin/setup` and contains secrets; it must not be committed
   ```bash
   echo "ecosystem.config.local.js" >> .gitignore
   git add .gitignore && git commit -m "Add generated local config to gitignore"
   ```

4. **Verify `re2` built correctly** (optional but preferred)
   ```bash
   node -e "require('re2'); console.log('re2 OK')"
   ```
   If this fails, the fallback is automatic — safe to continue.

5. **Check `better-sqlite3` built correctly**
   ```bash
   node -e "require('better-sqlite3')(':memory:'); console.log('sqlite OK')"
   ```
   If this fails, install `node-gyp`: `npm install -g node-gyp` and retry `npm install` in `bridge-server/`.

---

## ⬜ Phase 0 — TLS + Tailscale (Not Started)

- [ ] Install Tailscale on Mac and iPhone
- [ ] Connect both devices to same tailnet (`tailscale up`)
- [ ] Enable MagicDNS and HTTPS in Tailscale admin console
- [ ] Run `tailscale cert <hostname>` to get TLS certificate
- [ ] Configure Tailscale ACLs (iPhone → Mac ports 7000 and 7001)
- [ ] Run `./bin/setup` — generates secrets, stores in Keychain
- [ ] Store client secret in iPhone Safari password manager
- [ ] Verify cert: `openssl x509 -enddate -noout -in <cert-path>`
- [ ] Set `ALLOWED_ROOTS` to your project directories

---

## ⬜ Phase 1a — Minimal Live Loop (Not Started)

**iOS smoke gate — must pass on real iPhone before proceeding to 1b.**

- [ ] Start bridge + UI with pm2
- [ ] Confirm `pm2 status` shows both processes online
- [ ] Open `https://<tailnet-host>:7000` in iPhone Safari — no TLS warning
- [ ] Connection indicator turns green (authenticated)
- [ ] Send a short instruction (e.g., *"list files in the current directory"*)
- [ ] Verify claude process spawns (`pm2 logs remotedev-bridge`)
- [ ] See output stream to phone
- [ ] Complete one approval round-trip on device (Bash command)
- [ ] Verify "type APPROVE" blocks wrong input; correct input approves
- [ ] Task completes; session returns to IDLE

All of the above must pass on the real device, not desktop browser.

---

## ⬜ Phase 1b — Resilience + Persistence (Not Started)

- [ ] **DISCONNECTED state + gap recovery**
  - [ ] Drop connection mid-task (airplane mode); reconnect; verify full output recovered
  - [ ] Verify gap ≤50 uses ring buffer; gap >50 triggers `resync_required` + transcript tail
- [ ] **AWAITING_APPROVAL reconnect**
  - [ ] Disconnect during approval; reconnect within TTL; verify modal restored with correct remaining time
  - [ ] Disconnect during approval; wait for TTL to expire; reconnect; verify auto-deny occurred
- [ ] **Backpressure**
  - [ ] Simulate slow connection; verify `bridge_warning client_slow` at 30s
  - [ ] Verify `ws.close(1011)` at 60s; session stays RUNNING; reconnect delivers output
- [ ] **4003 token desync recovery**
  - [ ] Connect on phone; run `./bin/reload`; verify phone auto-recovers without lockout
- [ ] **Orphan scan**
  - [ ] Kill bridge with `SIGKILL`; restart; verify stray claude process killed within 5min
- [ ] **Offline transcript budget**
  - [ ] Disconnect during long task; accumulate >50MB; verify budget enforced
- [ ] **Parse degraded mode**
  - [ ] Inject malformed NDJSON; verify 5-error threshold triggers degraded mode
  - [ ] Verify raw lines streamed and stored in SQLite
- [ ] **WAL checkpoint**
  - [ ] After session ends: verify PASSIVE checkpoint runs; WAL file shrinks
- [ ] **Steady-heap test**
  - [ ] Run 100 sequential sessions; verify no memory growth (currently manual, not automated)
- [ ] **`./bin/test-tailnet` must pass** before merging this phase

---

## ⬜ Phase 2 — Next.js Chat UI (Not Started)

- [ ] Freeze protocol v1 (no breaking changes to event schemas after this point)
- [ ] Full UI QA against stub server (`node bridge-server/stub.js`)
- [ ] Test all `bridge_warning` subtypes render correct banners
- [ ] Test `resync_required` → "replaying missed output" message, then `transcript_chunk` rendering
- [ ] Test `persistenceDegraded` banner
- [ ] Test cert expiry warning display (if added to UI)
- [ ] Test offline budget banner
- [ ] Verify `controllerEpoch` in all mutating messages (browser DevTools Network tab)
- [ ] Test React error boundary → `client_error` round-trip; verify in bridge logs
- [ ] Test 4003 close → no lockout counter increment (check bridge logs)
- [ ] Test 1011 close → immediate reconnect + `resume_session`
- [ ] Mobile UX review: text sizes, tap targets, keyboard avoidance on iPhone
- [ ] Test on both iPhone SE (small screen) and iPhone Pro Max (large screen)

---

## ⬜ Phase 3 — Polish & UX (Not Started)

- [ ] Full transcript history (SQLite-backed, paginated scroll)
- [ ] Diff viewer for file changes (detect unified diff in output, render with syntax highlighting)
- [ ] Project switcher (list `ALLOWED_ROOTS`, let user select working directory)
- [ ] Dark mode toggle (Tailwind `dark:` classes; persist in localStorage)
- [ ] Mac menubar status indicator (separate Swift/Electron app or AppleScript; shows session state)
- [ ] Keyboard shortcuts for approve/deny on iPad

---

## ❌ Known Gaps / Not in v1

These are documented limitations — intentional for v1:

- ❌ **Tests not run yet** — written but need `npm install` + execution to verify they pass
- ❌ **No CI/CD pipeline** — no GitHub Actions, no automated test on PR
- ❌ **Bash tool sandboxing** — cannot sandbox at claude CLI level; approval + "type APPROVE" is the mechanism
- ❌ **SIGKILL/OOM cannot be trapped** — orphan scan compensates (≤5min detection window)
- ❌ **Single controller only** — second WS connection rejected; no read-only observer mode
- ❌ **Token rotation on reconnect** — same epoch persists through reconnect; new epoch only on new auth
- ❌ **No granular per-project allowlist** — `ALLOWED_ROOTS` is binary in/out; no per-command rules
- ❌ **No full lastAck-driven replay** — last-50 ring + resync; full bounded replay is v2
- ❌ **No conversation history pagination in UI** — current session only; full history via SQLite directly
- ❌ **`ecosystem.config.local.js` not in `.gitignore` yet** — generated by `bin/setup`; must be added manually (see Immediate Next Steps)
- ❌ **Steady-heap test not automated** — described in spec; requires manual verification
- ❌ **No concurrent endSession() test** — idempotency under concurrency not exercised in tests
- ❌ **re2 may not build on all platforms** — native addon; fallback is automatic but slower

---

## 📋 v2 / Future

- [ ] Multi-tab read-only observer mode
- [ ] Token rotation on every reconnect
- [ ] OS-level sandboxing (App Sandbox / seccomp-bpf)
- [ ] Granular per-project tool allowlist
- [ ] Full `lastAck`-driven bounded replay
- [ ] CI/CD pipeline (GitHub Actions: install, test, lint on PR)
- [ ] Conversation history sync (iCloud? git? local only?)
- [ ] Configurable approval TTL
- [ ] Configurable HMAC assertion TTL
- [ ] Automated TLS cert renewal via launchd
- [ ] Prometheus / metrics endpoint for session health
