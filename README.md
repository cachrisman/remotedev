# RemoteDev

**Control your Mac dev environment from your iPhone via a mobile chat interface.**

Send a natural language instruction from iPhone Safari — RemoteDev executes it against your local Mac dev environment via Claude, with tool approval flowing back to your phone.

```
iPhone Safari → Next.js UI (HTTPS, :7000)
                     ↓ GET /api/token → HMAC assertion
iPhone Safari → Bridge Server (WSS, :7001)
                     ↓ authenticate
                     ↓ spawn claude -p --output-format stream-json
                     ↓ approval modal ← tool calls
                     ↓ streaming output → chat UI
```

> **Status:** v0.16 — Implementation complete. Phases 0–1a are the path to first use.
> See [docs/TODO.md](docs/TODO.md) for current status and [docs/PLAN.md](docs/PLAN.md) for the full spec.

---

## Requirements

| Requirement | Notes |
|---|---|
| **Mac** (macOS 12+) | Where Claude runs |
| **iPhone** with Safari | Controller |
| **Node.js 20+** | Both bridge + UI |
| **Tailscale** | Network boundary; provides TLS cert |
| **Claude CLI** | `npm install -g @anthropic-ai/claude-code` |
| **pm2** | Process manager: `npm install -g pm2` |
| **Claude Pro subscription** | Required for `claude -p` headless mode |
| **jq** | Used by `bin/reload`: `brew install jq` |

---

## Quick Start

### 1. Clone and install dependencies

```bash
git clone <repo-url> remotedev
cd remotedev

# Install bridge dependencies
cd bridge-server && npm install && cd ..

# Install UI dependencies
cd ui && npm install && cd ..
```

### 2. Set up Tailscale (Phase 0)

```bash
# Install Tailscale, then:
tailscale up
```

**Enable HTTPS certificates** in the Tailscale admin console before running `tailscale cert`:
[https://login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns) → scroll to **HTTPS Certificates** → Enable.

```bash
# Get your machine's full Tailscale FQDN:
TAILNET_HOST=$(tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")')

# Create the cert directory and provision the TLS cert there
# (the project looks for certs at /var/lib/tailscale/certs/ by default)
sudo mkdir -p /var/lib/tailscale/certs
sudo tailscale cert --cert-file /var/lib/tailscale/certs/${TAILNET_HOST}.crt \
                    --key-file  /var/lib/tailscale/certs/${TAILNET_HOST}.key \
                    ${TAILNET_HOST}
```

> **Note:** If `tailscale cert` writes to the current directory instead (check for `<hostname>.crt` / `<hostname>.key` files), move them manually:
> ```bash
> sudo mv ${TAILNET_HOST}.crt ${TAILNET_HOST}.key /var/lib/tailscale/certs/
> ```
> Alternatively, set `TLS_CERT` and `TLS_KEY` in `.env.local` to point to wherever the files landed.

**Tailscale ACLs (personal tailnet — skip this):** The default Tailscale ACL for a single-user account already allows all your devices to reach each other, so no ACL changes are needed. If you're on a shared or corporate tailnet with a restrictive ACL policy, you'll need to add rules allowing your iPhone to reach your Mac on ports **7000** and **7001** — consult your tailnet admin.

### 3. Run interactive setup

```bash
./bin/setup
```

This generates secrets, stores the client secret in macOS Keychain, and writes `ecosystem.config.local.js`. Copy the displayed client secret into iPhone Safari's password manager for your tailnet hostname.

`ecosystem.config.js` automatically loads `ecosystem.config.local.js` at startup — no sourcing needed.

### 4. Build the UI

```bash
cd ui && npm run build && cd ..
```

### 5. Start with pm2

```bash
pm2 start ecosystem.config.js
pm2 save  # persist across reboots
```

### 6. iOS smoke gate (Phase 1a gate)

Open `https://<your-tailnet-host>:7000` in iPhone Safari:
1. Page loads without TLS warning
2. Connection indicator turns green (authenticated)
3. Type a short instruction and send
4. Approve the tool call if prompted
5. See output stream back

Once this works end-to-end on device, you're past the Phase 1a gate.

---

## Project Structure

```
remotedev/
├── bridge-server/          # Node.js WebSocket bridge
│   ├── index.js            # Main server entrypoint
│   ├── session.js          # Session lifecycle, approval FSM, gap recovery
│   ├── session-manager.js  # Global session registry + controller epoch
│   ├── auth.js             # HMAC validation, nonce cache, IP lockout
│   ├── db.js               # SQLite (better-sqlite3), WAL mode
│   ├── wal.js              # PASSIVE WAL checkpoint, rate-limited
│   ├── ndjson-framer.js    # Fault-tolerant NDJSON line parser
│   ├── path-validator.js   # Ancestor realpathSync + re2 ReDoS protection
│   ├── orphan-scan.js      # Finds/kills stray claude processes
│   ├── startup-checks.js   # Cert expiry, claude version, disk space
│   ├── stub.js             # Canned-sequence stub for UI dev
│   └── test/               # Node.js built-in test runner suite
├── ui/                     # Next.js 16 mobile chat UI
│   ├── app/
│   │   ├── api/token/      # HMAC assertion endpoint (force-dynamic)
│   │   └── page.tsx        # Main chat interface
│   ├── components/
│   │   ├── ApprovalModal   # "Type APPROVE" Bash confirmation
│   │   ├── ChatMessage     # Message rendering
│   │   └── WarningBanner   # bridge_warning display
│   ├── hooks/useWebSocket  # WS lifecycle, 4003/1011 recovery
│   └── lib/protocol.ts     # Zod schemas for all message types
├── bin/
│   ├── setup               # Interactive Phase 0 setup
│   ├── reload              # Restart with new token (4003-safe)
│   └── test-tailnet        # Tailnet integration test suite (phase gate)
├── ecosystem.config.js     # pm2 process config
├── .env.example            # Environment variable template
└── docs/                   # Full documentation
```

---

## Day-to-Day Operations

```bash
# Restart with a fresh token (clients auto-recover)
./bin/reload

# View logs
pm2 logs remotedev-bridge
pm2 logs remotedev-ui

# Run local unit tests
cd bridge-server && node --test test/**/*.test.js

# Run tailnet integration tests (before merging reconnect/approval/path changes)
./bin/test-tailnet --skip-manual
```

---

## Security Model (Summary)

| Layer | Mechanism |
|---|---|
| Network | Tailscale ACLs — only your iPhone device reaches ports 7000/7001 |
| Client secret | 32-byte hex in macOS Keychain + iPhone password manager |
| HMAC assertion | `GET /api/token` returns `HMAC(token, nonce:ts)` — raw token never in browser |
| Controller epoch | Minted on auth; stale tabs get `ws.close(4403)` |
| Path validation | Ancestor `realpathSync` + `path.relative()` tail; re2 ReDoS protection |
| Bash approvals | UI requires typing `"APPROVE"` exactly; defends against accidents |

See [docs/PLAN.md](docs/PLAN.md) for the complete security model.

---

## Documentation

| Doc | Description |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | Full project specification (v0.16) |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | Detailed operational guide |
| [docs/IMPLEMENTATION_LOG.md](docs/IMPLEMENTATION_LOG.md) | What was built and how |
| [docs/TODO.md](docs/TODO.md) | Status: done / in progress / remaining |
| [docs/TEST_PROCEDURES.md](docs/TEST_PROCEDURES.md) | How to run and interpret tests |

---

## License

MIT — see [LICENSE](LICENSE).
