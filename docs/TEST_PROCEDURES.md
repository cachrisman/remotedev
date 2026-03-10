# Test Procedures — RemoteDev v0.16

## Overview

RemoteDev has two test suites:

1. **Unit tests** — run locally with the Node.js built-in test runner (no framework required)
2. **Tailnet integration tests** — run against a live deployment; full suite requires a real iPhone on the tailnet; use `--skip-manual` for the automated subset only

**Phase gate:** `./bin/test-tailnet` must pass (automated + manual sections) before merging any change that touches session reconnect logic, the approval FSM, or path validation. See the [Phase Gate Requirement](#phase-gate-requirement) section for the exact list of affected files.

**IMPORTANT:** The unit tests were written as part of the initial implementation but have not yet been run. The first run must verify that they actually pass. If any test fails, fix the implementation (or the test if the test itself is wrong) before treating the suite as green.

---

## Prerequisites

### For unit tests

- Node.js 20 or later
- npm
- bridge-server dependencies installed:

```bash
cd bridge-server && npm install
```

- **For db tests:** `better-sqlite3` native addon must build. This requires `node-gyp` and a working C++ compiler. If the build fails, see [Known First-Run Issues](#known-first-run-issues-to-watch-for).
- **For redos tests:** The `re2` native addon is optional. If it fails to build, `path-validator` falls back to a 50 ms timeout guard around native `RegExp`. Tests should still pass in fallback mode.

### For tailnet integration tests

- Tailscale installed and connected on the Mac
- bridge-server running (`BRIDGE_AUTH_TOKEN=... node bridge-server/index.js`)
- UI running (`npm run dev` in `ui/`)
- iPhone enrolled in the same tailnet (required for manual tests; not required for `--skip-manual`)
- Environment variables set (see [Tailnet Test Suite](#tailnet-test-suite))

---

## Running Unit Tests

Run the entire unit test suite from inside `bridge-server/`:

```bash
cd bridge-server
node --test test/**/*.test.js
```

Run individual test files:

```bash
node --test test/auth.test.js
node --test test/db.test.js
node --test test/ndjson-framer.test.js
node --test test/path-validator.test.js
node --test test/redos.test.js
node --test test/session-manager.test.js
node --test test/wal.test.js
```

---

## Test File Descriptions

### 1. `auth.test.js`

Tests the HMAC assertion layer that gates WebSocket upgrades.

- Valid assertion is accepted
- Expired assertion (timestamp outside TTL) is rejected
- Tampered payload (assertion body modified after signing) is rejected
- Wrong secret produces a verification failure
- Nonce replay detection: submitting the same nonce twice is rejected
- IP lockout: 5 consecutive failures from the same IP trigger a lockout
- Stale-assertion rejection does not increment the IP failure counter (avoids clock-skew lockouts)

### 2. `db.test.js`

Tests the SQLite persistence layer (`db.js`).

- Session CRUD: `insertSession`, `updateSessionState`, `updateSessionEnd`
- Transcript batch insert followed by a tail query that respects the `maxRows` limit
- Audit log insertion
- Client error count increment and retrieval

### 3. `ndjson-framer.test.js`

Tests the streaming line framer that wraps WebSocket chunks into complete NDJSON lines.

- A complete line followed by `\n` is emitted immediately
- Partial lines are buffered across multiple `push()` calls and emitted when the newline arrives
- `flush()` emits any remaining buffered content and resets state
- Empty lines (bare `\n`) are skipped without emitting
- Lines that exceed the size limit trigger the `onError` callback with `line_too_long`
- A chunk split exactly in the middle of a line is reassembled correctly

### 4. `path-validator.test.js`

Tests `validatePath()`, the function that prevents path traversal outside `ALLOWED_ROOTS`.

- Path inside the allowed root: accepted
- Path outside the allowed root: rejected
- Path containing `..` traversal components: rejected
- Non-existent path: validated using ancestor directory (safe as long as ancestor is inside root)
- Symlink whose real path resolves inside the root: accepted
- `null` argument: rejected
- Symlink whose real path resolves outside the root: rejected

### 5. `redos.test.js`

Tests the ReDoS protection layer for path input.

- A safe regex pattern completes in under 50 ms
- An adversarial input against a backtracking pattern (e.g., `(a+)+`) completes within 500 ms — either because `re2` evaluates it in linear time, or because the timeout guard aborts it
- `null` input returns `null`
- Empty string input returns `null`

### 6. `session-manager.test.js`

Tests the in-memory session registry.

- `createSession` / `getSession` / `removeSession` round-trip
- Each session receives a unique monotonic epoch value
- Epoch validation: correct epoch passes, wrong epoch fails, `null` epoch fails
- `activeCount` excludes sessions in `IDLE` state
- Controller lifecycle: `setController` associates a WebSocket, `releaseController` clears it, attempting release with a wrong session ID is a no-op

### 7. `wal.test.js`

Tests the WAL checkpoint scheduler.

- Checkpoint runs without error when no sessions are active
- Rate limiter prevents a second checkpoint run within the 5-minute cooldown window

---

## Expected Test Output (node --test format)

### Passing run

```
TAP version 13
# Subtest: auth
    # Subtest: valid assertion is accepted
    ok 1 - valid assertion is accepted
    # Subtest: expired assertion is rejected
    ok 2 - expired assertion is rejected
    # Subtest: tampered payload is rejected
    ok 3 - tampered payload is rejected
    # Subtest: wrong secret is rejected
    ok 4 - wrong secret is rejected
    # Subtest: nonce replay is rejected
    ok 5 - nonce replay is rejected
    # Subtest: IP lockout after 5 failures
    ok 6 - IP lockout after 5 failures
    # Subtest: stale assertion does not increment lockout counter
    ok 7 - stale assertion does not increment lockout counter
    1..7
ok 1 - auth
...
# tests 42
# pass  42
# fail  0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 312
```

### Failing run (example)

```
TAP version 13
# Subtest: auth
    # Subtest: valid assertion is accepted
    not ok 1 - valid assertion is accepted
      ---
      duration_ms: 1.234
      failureType: 'testCodeFailure'
      error: 'Expected true but got false'
      code: 'ERR_ASSERTION'
      ...
      ---
    1..1
not ok 1 - auth
...
# tests 42
# pass  41
# fail  1
# duration_ms 289
```

Exit code is `0` for a full pass, non-zero for any failure. CI should treat non-zero exit as a blocking failure.

---

## Known First-Run Issues to Watch For

**better-sqlite3 build failure**
`better-sqlite3` requires `node-gyp` and a working C++ toolchain. If `npm install` in `bridge-server/` produces a build error:

```bash
npm install -g node-gyp
cd bridge-server && npm rebuild better-sqlite3
```

On macOS, also ensure Xcode command-line tools are installed: `xcode-select --install`.

**re2 build failure**
`re2` is optional. If the native addon fails to build, `path-validator.js` automatically falls back to a 50 ms timeout guard around native `RegExp`. The `redos.test.js` tests are written to pass in both modes. The build failure itself is not a blocker.

**db.test.js temp directory**
`db.test.js` creates temporary SQLite databases under `os.tmpdir()`. If the process does not have write permission to the system temp directory, the test will fail with a filesystem error. Ensure the user running the tests can write to `os.tmpdir()`.

**path-validator.test.js symlinks**
`path-validator.test.js` creates symlinks to test symlink traversal. Some environments (Docker containers without `--privileged`, or certain CI sandboxes) restrict `symlink(2)`. If symlink creation fails, the symlink-related test cases will fail with a permission error. This is an environment limitation, not a code bug. Run in an environment that permits symlinks, or skip those cases manually.

**wal.test.js**
`wal.test.js` imports `db.js` and calls `openDb()`. It needs write permission to `os.tmpdir()` for the same reason as `db.test.js`.

---

## Tailnet Test Suite

### Running

```bash
# Automated subset only (no iPhone required):
./bin/test-tailnet --skip-manual

# Full suite (iPhone on tailnet required):
./bin/test-tailnet
```

### Environment

The following environment variables must be set before running:

```bash
export TAILNET_HOST=mac.your-tailnet.ts.net   # your Mac's Tailscale hostname
export BRIDGE_AUTH_TOKEN=<your-token>          # token the bridge validates
export REMOTEDEV_CLIENT_SECRET=<your-secret>  # shared with the iOS app
export BRIDGE_PORT=7001
export UI_PORT=7000
```

### Automated tests (no iPhone required)

These run regardless of `--skip-manual`:

1. Bridge port 7001 reachable from the test host (`nc -z $TAILNET_HOST $BRIDGE_PORT`)
2. UI port 7000 reachable (`nc -z $TAILNET_HOST $UI_PORT`)
3. `GET /api/token` returns a JSON object containing `wsAuth`, `nonce`, and `ts`
4. HMAC signature locally verified against the returned `wsAuth` and `nonce`
5. `/api/token` is force-dynamic: two consecutive calls return different nonce values
6. TLS certificate is valid and reports the number of days remaining
7. `./bin/reload` completes without error and a token refresh after reload succeeds

### Manual tests (require iPhone on tailnet)

These run only when `--skip-manual` is not passed. Each requires a human to perform the action on the device and confirm the result:

1. **WSS trust** — Open Safari on iPhone, connect to the bridge WebSocket URL; confirm no certificate warning is shown
2. **Auth end-to-end** — Complete the authentication flow on the device; confirm `controllerEpoch` appears in the UI session state
3. **Long task disconnect** — Start a long-running task; simulate cellular drop (airplane mode); restore connectivity; confirm reconnect succeeds and full output is present
4. **AWAITING_APPROVAL reconnect** — Trigger an approval prompt; disconnect before responding; reconnect within TTL; confirm the approval modal is restored
5. **Gap recovery cellular** — Reproduce gap recovery across a cellular network transition
6. **visibilitychange reconnect** — Background the app (trigger `visibilitychange`); foreground it; confirm reconnect
7. **Bash APPROVE** — At an approval prompt, type an incorrect confirmation string; confirm it is blocked; type the correct string; confirm approval proceeds
8. **client_error telemetry** — Send a malformed chunk to the bridge; confirm a `client_error` event appears in the bridge log

---

## Phase Gate Requirement

`./bin/test-tailnet` must pass — both the automated section and the full manual section — before merging any pull request that touches:

- **Session reconnect logic**: `onDisconnect`, `onReconnect`, gap recovery
- **Approval FSM**: `handleApprovalResponse`, `emitControlResponse`, `preDisconnectState`
- **Path validation**: `validatePath`, `resolveAllowedRoots`

This is not optional. PRs modifying these areas without a passing tailnet run will not be merged.

---

## Test Coverage Gaps

The following scenarios are described in the design spec but are not yet covered by any automated test. They are tracked here so they are not forgotten:

- Backpressure stall at exactly 60 s triggering `ws.close(1011)`
- `endSession()` called simultaneously from 3 concurrent code paths (idempotency under concurrency)
- Steady-heap test: 100 sequential sessions verifying no unbounded memory growth (described in spec, not yet implemented)
- `proc.on('close')` firing while `destroyed=true` (the early-return guard)
- WAL checkpoint mode `PASSIVE` specifically vs `TRUNCATE` (current test only checks that no error is thrown, not which mode ran)
- Integration: full spawn → NDJSON framing → approval gate → output end-to-end without a real `claude` binary (the stub covers this partially but not as a formal test)
