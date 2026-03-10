# Contributing to RemoteDev

RemoteDev is a bridge that lets an iPhone control a `claude` CLI session running on a Mac over a private Tailscale network. The project is pre-release (v0.16). Contributions are welcome, but please read this document before opening a pull request.

---

## Development Setup

```bash
git clone <repo-url>
cd remote-dev

# Install bridge-server dependencies (includes native addons: better-sqlite3, re2)
cd bridge-server && npm install && cd ..

# Install UI dependencies
cd ui && npm install && cd ..
```

Node.js 20 or later is required. The bridge-server has no transpile step; it runs as plain CommonJS. The UI is Next.js and does have a build step.

---

## Codebase Structure

```
remote-dev/
├── bridge-server/
│   ├── index.js            # Entry point; HTTP + WebSocket server setup
│   ├── auth.js             # HMAC assertion verification, nonce cache, IP lockout
│   ├── db.js               # SQLite session/transcript/audit persistence (better-sqlite3)
│   ├── ndjson-framer.js    # Streaming line framer for NDJSON over WebSocket
│   ├── path-validator.js   # validatePath() — symlink-aware traversal prevention
│   ├── redos.js            # ReDoS guard wrapping re2 or native RegExp with timeout
│   ├── session-manager.js  # In-memory session registry with epoch tracking
│   ├── wal.js              # WAL checkpoint scheduler
│   ├── stub.js             # Development stub — simulates claude without real binary
│   └── test/
│       ├── auth.test.js
│       ├── db.test.js
│       ├── ndjson-framer.test.js
│       ├── path-validator.test.js
│       ├── redos.test.js
│       ├── session-manager.test.js
│       └── wal.test.js
├── ui/
│   ├── app/                # Next.js App Router pages and layouts
│   ├── components/         # React components (terminal, approval modal, etc.)
│   └── lib/                # Client-side WebSocket logic, auth helpers
├── bin/
│   ├── test-tailnet        # Tailnet integration test runner
│   └── reload              # Sends a reload signal to the bridge process
├── docs/
│   ├── PLAN.md             # Design spec and threat model
│   └── TEST_PROCEDURES.md  # Full test procedures (read before running tests)
├── CONTRIBUTING.md         # This file
└── SECURITY.md             # Security policy
```

---

## Running Tests

Unit tests use the Node.js built-in test runner. No test framework is needed.

```bash
cd bridge-server
node --test test/**/*.test.js
```

Run a single file during development:

```bash
node --test test/auth.test.js
```

See `docs/TEST_PROCEDURES.md` for full details, including expected output, known first-run issues, and the tailnet integration test suite. Read it before running tests for the first time — the tests were written as part of initial implementation and have not yet been verified to pass.

---

## Using the Stub for UI Development

You do not need a real `claude` binary or a real iPhone to work on the UI. The stub simulates a claude session and speaks the same WebSocket protocol as the real bridge.

**Terminal 1 — start the stub bridge:**

```bash
BRIDGE_AUTH_TOKEN=test REMOTEDEV_CLIENT_SECRET=test node bridge-server/stub.js
```

The stub listens on port 7001 by default and accepts any assertion signed with the test secret.

**Terminal 2 — start the UI dev server:**

```bash
cd ui
NEXT_PUBLIC_BRIDGE_WS_URL=ws://localhost:7001 NEXT_PUBLIC_CLIENT_SECRET=test npm run dev
```

Open `http://localhost:7000` (or whatever port Next.js binds) in a browser. The UI connects to the stub and you can exercise the full message flow without Tailscale or a real device.

---

## Code Style

- Plain Node.js (CommonJS) in `bridge-server/`; no TypeScript, no transpilation
- Next.js (App Router, TypeScript optional) in `ui/`
- No linter is configured yet — follow the patterns in the existing files
- All `.js` files in `bridge-server/` must begin with `'use strict';`
- Prefer `const` over `let`; avoid `var`
- Async functions for I/O; avoid callback-style where async/await is cleaner
- Error messages should be lowercase strings (consistent with existing error objects)
- Do not add dependencies to `bridge-server/` without discussing first — the dependency surface is intentionally small

---

## Phase Gate

`./bin/test-tailnet` must pass before merging any PR that touches:

- Session reconnect logic (`onDisconnect`, `onReconnect`, gap recovery)
- Approval FSM (`handleApprovalResponse`, `emitControlResponse`, `preDisconnectState`)
- Path validation (`validatePath`, `resolveAllowedRoots`)

Run `./bin/test-tailnet` locally and include the output in your PR description. See `docs/TEST_PROCEDURES.md` for environment setup.

---

## Security

These rules apply to all contributions. They are not suggestions.

- Never log client secrets, raw `BRIDGE_AUTH_TOKEN` values, or HMAC keys — not even at debug level
- All comparisons of secrets or tokens must use a constant-time compare function (see `auth.js` for the existing pattern)
- Any user-supplied path must pass through `validatePath()` before being used in a filesystem operation — no exceptions
- New WebSocket message types must validate the sender's epoch before acting
- If you add a new regex that operates on user-supplied input, run it through `redos.js` rather than using `RegExp` directly

---

## Submitting Pull Requests

1. Describe **what changed** and **why** in the PR description — not just what the diff shows
2. Reference the relevant section of `docs/PLAN.md` if the change relates to a design decision documented there
3. Include test results:
   - Paste the output of `node --test test/**/*.test.js` from `bridge-server/`
   - If the PR touches reconnect, approval, or path validation: paste the output of `./bin/test-tailnet`
4. Keep PRs focused. A PR that fixes a bug and also refactors an unrelated module is harder to review and harder to revert

---

## Open Questions

These are unresolved design questions from the spec. If you have opinions, open an issue or start a discussion before writing code.

- **Conversation history sync**: the iPhone currently has no way to retrieve prior transcript on first connect; should the bridge push a history snapshot on WebSocket open?
- **Approval TTL configurability**: the TTL for `AWAITING_APPROVAL` state is currently hardcoded; should it be an environment variable?
- **Token rotation on reconnect**: should a new token be issued each time the iPhone reconnects, or is the existing behavior (token valid until bridge restart) acceptable?
- **Menubar indicator**: a macOS menu bar item showing bridge status (connected/idle/error) has been discussed but not designed
- **HMAC assertion TTL configurability**: currently hardcoded; same question as approval TTL

---

## License

MIT. See `LICENSE` file.
