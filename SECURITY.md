# Security Policy

## Security Model

RemoteDev uses a layered security approach. Each layer is independent — a failure in one does not necessarily compromise the system.

### Layer 1 — Tailscale Device ACLs (Primary Boundary)

Only your iPhone's Tailscale device can reach ports 7000 and 7001. This is the primary network perimeter. Keep ACLs narrow: allow only the specific device tag for your iPhone, not `*` or `autogroup:members`.

### Layer 2 — Static Client Secret

A 32-byte hex secret stored in macOS Keychain and iPhone Safari password manager. Required in every `authenticate` message. Never logged by the bridge. Defends against ACL misconfiguration.

### Layer 3 — HMAC WS Assertion

`GET /api/token` returns `{ wsAuth: HMAC(BRIDGE_AUTH_TOKEN, nonce:ts), nonce, ts }`. The raw `BRIDGE_AUTH_TOKEN` never reaches the browser. The bridge validates:
- HMAC signature (via `crypto.timingSafeEqual`)
- Timestamp within 30 seconds
- Nonce not previously seen (replay cache, 30s TTL)

This eliminates XSS/copy-paste/shoulder-surfing exposure of the bridge token and prevents replay attacks.

### Layer 4 — Controller Epoch Token

On successful authentication, the bridge mints a `controllerEpoch` UUID stored in `SessionManager` (global, not per-session). All mutating client→server messages must include the current epoch. A stale tab (e.g., after a lease race) receives `bridge_warning { subtype: 'stale_epoch' }` followed by `ws.close(4403)` — hard disconnect, not silent ignore.

### Layer 5 — Tool Execution Boundary

- `workingDir` validated against `ALLOWED_ROOTS` at session creation using `fs.realpathSync`
- All tool-input paths validated via ancestor `realpathSync` + `path.relative()` tail computation (symlink-safe)
- Claude subprocess spawned without `shell: true`, with explicit argv
- Path extraction regex uses `re2` (linear-time) or a 50ms-timeout fallback to prevent ReDoS

---

## Reporting Vulnerabilities

Please report security vulnerabilities via email to **security@example.com** (replace with actual contact before publishing).

Include in your report:
- Description of the vulnerability
- Steps to reproduce
- Affected version (see `package.json`)
- Potential impact assessment
- Any proof-of-concept code (if applicable)

Please **do not** open a public GitHub issue for security vulnerabilities.

We aim to acknowledge reports within 48 hours and provide a fix timeline within 7 days.

---

## Scope

### In Scope

- Authentication bypass (skipping HMAC validation, client secret, or nonce check)
- Path traversal to files outside `ALLOWED_ROOTS`
- WebSocket message injection that bypasses controller epoch validation
- ReDoS via crafted path input reaching the regex engine
- SQLite injection via session/transcript data
- Token exposure (raw `BRIDGE_AUTH_TOKEN` reaching the browser)
- Brute-force lockout bypass

### Out of Scope

- **Prompt injection via model output** — explicitly documented as out of scope in the threat model. The system defends against accidents, not against a compromised or adversarial model. See the [Bash Threat Model](docs/PLAN.md#security-model) in the spec.
- Tailscale itself and its ACL system
- Social engineering of the user (tricking them to type "APPROVE" for a malicious command)
- Vulnerabilities requiring physical access to the Mac
- Denial of service against the bridge from an already-authenticated attacker (authenticated clients are trusted)

---

## Known Limitations

These are intentional design constraints documented in the spec, not vulnerabilities:

**Bash tool cannot be sandboxed at the claude CLI level.**
The Claude CLI does not expose a tool execution wrapper. The approval gate + "type APPROVE" UI friction is the enforcement mechanism. This defends against *accidents and unintended commands* — not against prompt injection or deliberate misuse. Do not use RemoteDev in threat models where the AI model itself may be adversarial.

**Global process traps cannot fire on SIGKILL, OOM kill, or power loss.**
The periodic orphan scan (every 5 minutes) compensates, but there is a detection window of up to 5 minutes during which stray claude processes may remain running after a bridge crash.

**Client secret is static.**
There is no automated rotation. Rotation requires manual steps (see [User Guide: Rotating the Client Secret](docs/USER_GUIDE.md#rotating-the-client-secret)). The secret is stored in macOS Keychain and never written to disk in plaintext by the bridge.

**re2 native addon may not build on all platforms.**
If `re2` fails to build, the path validator falls back to a 50ms-timeout native RegExp. The timeout prevents ReDoS but is a weaker guarantee than RE2's linear-time property. Prefer ensuring `re2` builds correctly in your environment.

**Single controller at a time.**
A second authenticated connection takes the `controllerEpoch`, disconnecting the first tab with `ws.close(4403)`. There is no multi-user access control beyond this.

---

## Supported Versions

| Version | Support Status |
|---|---|
| v0.16 (current) | Active — all issues treated as critical |
| < v0.16 | Unsupported |

This project is pre-release. There is no stable release yet. All security issues against the current branch are treated as high priority.

---

## Security Checklist for Contributors

When making changes, verify:

- [ ] No client secrets, raw `BRIDGE_AUTH_TOKEN`, or private keys are logged at any level
- [ ] Auth paths use `crypto.timingSafeEqual` for secret comparison (not `===`)
- [ ] All new file-path handling goes through `validatePath()` in `path-validator.js`
- [ ] New regex patterns in path processing use `safeMatch()` (re2-backed)
- [ ] New C→S message handlers validate `controllerEpoch` if they are mutating operations
- [ ] New async callbacks in `session.js` have `if (this.destroyed) return` guards
- [ ] New SQLite writes go through the batch queue (not direct synchronous calls in the hot path)
- [ ] `BRIDGE_AUTH_TOKEN` is never sent to the browser — only `wsAuth` (the HMAC output)
