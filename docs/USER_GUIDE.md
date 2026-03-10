# RemoteDev — User Guide

Detailed operational reference for RemoteDev v0.16. For the quick-start, see the [README](../README.md). For the full design specification, see [docs/PLAN.md](PLAN.md).

---

## Table of Contents

1. [Before You Begin](#before-you-begin)
2. [First-Time Setup (Phase 0)](#first-time-setup-phase-0)
3. [Starting the Servers](#starting-the-servers)
4. [Connecting from iPhone](#connecting-from-iphone)
5. [Sending Instructions](#sending-instructions)
6. [Project Picker](#project-picker)
7. [Session States](#session-states)
8. [Approving Tool Calls](#approving-tool-calls)
9. [Reconnecting After Drops](#reconnecting-after-drops)
10. [Restarting the Bridge](#restarting-the-bridge-binreload)
11. [Viewing Logs](#viewing-logs)
12. [Rotating the Client Secret](#rotating-the-client-secret)
13. [TLS Certificate Renewal](#tls-certificate-renewal)
14. [Warning Banners](#warning-banners)
15. [Troubleshooting](#troubleshooting)
16. [Security Notes](#security-notes)
17. [Database](#database)

---

## Before You Begin

Verify you have everything installed:

| Requirement | Check | Install |
|---|---|---|
| macOS 12+ | — | — |
| Node.js 20+ | `node --version` | [nodejs.org](https://nodejs.org) |
| npm | `npm --version` | bundled with Node |
| Tailscale (Mac) | `tailscale status` | [tailscale.com/download](https://tailscale.com/download) |
| Tailscale (iPhone) | App Store | search "Tailscale" |
| Claude CLI | `claude --version` | `npm install -g @anthropic-ai/claude-code` |
| pm2 | `pm2 --version` | `npm install -g pm2` |
| jq | `jq --version` | `brew install jq` |
| Claude Pro subscription | — | Required for `claude -p` headless mode |

---

## First-Time Setup (Phase 0)

### Step 1: Connect Tailscale on both devices

On your Mac:
```bash
tailscale up
```

On your iPhone: open the Tailscale app and sign in to the same account.

Both devices must appear in the same tailnet. Verify with:
```bash
tailscale status
```

### Step 2: Get your tailnet hostname

```bash
tailscale status --self | grep -oE '\S+\.ts\.net' | head -1
# e.g.: mac.tail1234.ts.net
```

### Step 3: Get a TLS certificate

```bash
tailscale cert mac.tail1234.ts.net
# Certificate written to /var/lib/tailscale/certs/mac.tail1234.ts.net.crt
# Key written to    /var/lib/tailscale/certs/mac.tail1234.ts.net.key
```

If `tailscale cert` fails, ensure your account has HTTPS enabled at [login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns) (enable MagicDNS and HTTPS).

### Step 4: Configure Tailscale ACLs

In the Tailscale admin console ([login.tailscale.com/admin/acls](https://login.tailscale.com/admin/acls)), allow your iPhone to reach your Mac on the RemoteDev ports:

```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["tag:iphone"],
      "dst": ["tag:mac:7000", "tag:mac:7001"]
    }
  ],
  "tagOwners": {
    "tag:iphone": ["autogroup:member"],
    "tag:mac":    ["autogroup:member"]
  }
}
```

Tag your devices in the Tailscale admin console accordingly, or use `autogroup:self` for a simpler personal setup.

### Step 5: Run interactive setup

From the repo root:
```bash
./bin/setup
```

This will:
1. Detect your tailnet hostname
2. Check for an existing TLS certificate
3. Generate `BRIDGE_AUTH_TOKEN` (32-byte hex, shared between bridge and Next.js)
4. Generate `REMOTEDEV_CLIENT_SECRET` (32-byte hex)
5. Store the client secret in macOS Keychain
6. Prompt for your `ALLOWED_ROOTS` (directories claude is allowed to access)
7. Write `ecosystem.config.local.js` with all generated values

### Step 6: Store the client secret on your iPhone

After `./bin/setup` completes, it displays the client secret. Copy it into iPhone Safari's password manager for your tailnet hostname (e.g., `mac.tail1234.ts.net`).

When you open the UI in Safari, it will autofill the secret on first connection.

### Step 7: Configure ALLOWED_ROOTS

`ALLOWED_ROOTS` is a colon-separated list of directories that claude is allowed to read and write. The bridge validates all file paths against this list using `realpathSync`. Be specific — only include project directories you want accessible.

Example in `ecosystem.config.local.js`:
```js
process.env.ALLOWED_ROOTS = '/Users/yourname/projects:/Users/yourname/work';
```

---

## Starting the Servers

### Install dependencies (first time only)

```bash
# Bridge server
cd bridge-server && npm install && cd ..

# UI
cd ui && npm install && npm run build && cd ..
```

> **Note:** `better-sqlite3` and `re2` are native addons and require `node-gyp`. If `re2` fails to build, the path validator falls back to a 50ms-timeout native RegExp. Everything still works.

### Start with pm2

```bash
pm2 start ecosystem.config.js
pm2 save   # persist across reboots
pm2 startup  # configure pm2 to start on login (follow the instructions it prints)
```

This starts three processes:

| pm2 name | Role | Port |
|---|---|---|
| `remotedev-bridge` | WebSocket bridge server | 7001 (direct WSS) |
| `remotedev-ui` | Next.js UI server (internal) | 7000 (localhost only) |
| `remotedev-tailscale-serve` | `tailscale serve` HTTPS reverse proxy | 443 / tailnet HTTPS |

The UI is **not** served directly on port 7000 to your iPhone. Instead, `tailscale serve` acts as a TLS-terminating reverse proxy and forwards requests from `https://mac.tail1234.ts.net` → `http://localhost:7000`. This means your iPhone connects to port 443 (standard HTTPS), not a custom port.

### Verify all three processes are running

```bash
pm2 status
```

You should see `remotedev-bridge`, `remotedev-ui`, and `remotedev-tailscale-serve` all online.

### Check the bridge started cleanly

```bash
pm2 logs remotedev-bridge --lines 20
```

Look for:
- `Allowed roots resolved`
- `SQLite opened`
- `Bridge server listening` on port 7001

---

## Connecting from iPhone

1. Open Safari on iPhone
2. Navigate to `https://mac.tail1234.ts.net` (your tailnet hostname — **no port number**)
3. Safari should connect without a certificate warning (if it does warn, re-run `tailscale cert`)
4. The connection indicator in the top-left should turn **green** within a few seconds

If prompted for the client secret, use the password Safari saved in Step 6 of setup.

> **iPhone safe areas:** The UI automatically insets its content for the notch, Dynamic Island, and home indicator using CSS `env(safe-area-inset-*)`. No special setup is needed; it just works in Safari.

---

## Sending Instructions

Once connected (green indicator, "Ready" status):

1. Tap the text area at the bottom
2. Type a natural language instruction:
   - *"Add a loading spinner to the dashboard component"*
   - *"Fix the TypeScript error in src/auth/login.ts"*
   - *"Run the test suite and show me the failures"*
3. Tap **Send** (or press Return on a keyboard)

The UI sends the instruction to the bridge, which spawns a `claude -p` process in your configured working directory. Output streams back in real time.

> **Note:** The Send button and text area are disabled while the WebSocket is connecting or authenticating. Wait for the green indicator before typing your instruction.

---

## Project Picker

If your `ALLOWED_ROOTS` contains **more than one directory**, the UI shows a project picker before creating a session. Tap the directory you want to work in, and the session is created with that directory as the working directory for `claude`.

```
┌─────────────────────────────────┐
│  Select a project               │
│                                 │
│  > /Users/you/projects/web-app  │
│    /Users/you/projects/api      │
│    /Users/you/work/client-x     │
└─────────────────────────────────┘
```

If `ALLOWED_ROOTS` has only one directory, the picker is skipped and the session starts immediately.

To switch projects, end the current session and reload the page — the picker will appear again on the next connection.

---

## Session States

| State | Indicator | Meaning |
|---|---|---|
| **IDLE** | "Ready" | No task running; you can send an instruction |
| **RUNNING** | "Running..." | Claude is executing; output streaming |
| **AWAITING_APPROVAL** | "Waiting for approval" | Claude wants to use a tool; your approval required |
| **DISCONNECTED** | "Reconnecting..." | WS connection lost; bridge is buffering output |

Only one task runs at a time. If you send while RUNNING, you'll see a "Session is busy" message.

---

## Approving Tool Calls

When Claude calls a tool (read a file, write a file, run a command), an approval modal appears.

### Non-Bash tools (Read, Write, Edit, etc.)

The modal shows:
- Tool name
- Input parameters (file path, content preview, etc.)

Tap **Approve** to allow or **Deny** to block.

### Bash commands

Bash is treated with extra caution because it can run arbitrary commands.

The modal shows:
- The exact command to be executed
- A text field requiring you to type **`APPROVE`** (exactly, all caps)

You must read the command and deliberately type `APPROVE` to proceed. Any other text keeps the Approve button disabled.

### Approval TTL

Each approval has a 60-second timer. If the timer expires before you respond:
- While connected: the tool call is auto-denied
- While disconnected: the TTL-expiry fires the deny when triggered

If you reconnect before the TTL expires, the approval modal is restored with the remaining time.

---

## Reconnecting After Drops

RemoteDev is designed to survive cellular drops gracefully.

**What happens when you lose connection:**
1. Bridge detects WS close, transitions session to `DISCONNECTED`
2. Claude process keeps running; output buffered to ring buffer and SQLite
3. Bridge starts a 5-minute "orphan timer" — if you don't reconnect, the session ends

**What happens when you reconnect:**
1. UI automatically attempts reconnect (you see "Reconnecting...")
2. On successful re-auth, UI sends `resume_session`
3. Bridge restores previous state (`RUNNING`, `AWAITING_APPROVAL`, etc.)
4. **Gap recovery** delivers any output you missed:
   - Small gap (≤50 messages): replayed directly from ring buffer
   - Large gap: bridge sends `resync_required`, then streams transcript tail
5. You see "Reconnected — replaying missed output..." in the chat

**If you were mid-approval when you dropped:**
- The approval modal is restored with remaining TTL time
- If TTL expired while you were disconnected, the tool is auto-denied and Claude continues

---

## Restarting the Bridge (`./bin/reload`)

Use `./bin/reload` whenever you need to restart the bridge (config change, update, etc.):

```bash
./bin/reload
```

This:
1. Generates a new `BRIDGE_AUTH_TOKEN`
2. Restarts both `remotedev-bridge` and `remotedev-ui` with `pm2 restart --update-env`
3. Waits for the bridge to become ready on port 7001

**What your iPhone sees:** The WS connection closes with code 4003. The UI detects this, clears its cached token, fetches a fresh one from `/api/token`, and reconnects automatically. You don't need to reload Safari.

> **Important:** Always use `./bin/reload`, never `pm2 reload`. `pm2 reload` does a graceful reload that doesn't properly update environment variables.

> **Important:** Never manually run `pm2 restart remotedev-bridge` alone — both processes share `BRIDGE_AUTH_TOKEN`, so restarting only one will break auth.

---

## Viewing Logs

```bash
# Live bridge logs
pm2 logs remotedev-bridge

# Live UI logs
pm2 logs remotedev-ui

# Last 50 lines of bridge logs
pm2 logs remotedev-bridge --lines 50

# JSON format (pipe to jq)
pm2 logs remotedev-bridge --raw | jq .
```

### Key log events to watch for

| Event | What it means |
|---|---|
| `Client authenticated` | iPhone connected successfully |
| `Claude process spawned` | Instruction received; claude started |
| `Claude process closed` | Task completed |
| `Orphan claude process killed` | Stray process from previous crash cleaned up |
| `Session disconnected` | WS dropped; buffering output |
| `Session reconnected` | WS restored |
| `Parse degraded mode entered` | Claude output has 5+ consecutive parse errors |
| `WAL checkpoint (PASSIVE) complete` | SQLite WAL checkpoint ran |
| `IP locked out` | 5 bad auth attempts from same IP |

---

## Rotating the Client Secret

If you suspect the client secret has been compromised, or as a periodic precaution:

```bash
# 1. Remove old secret from Keychain
security delete-generic-password -a remotedev -s remotedev-client-secret

# 2. Generate and store a new one
NEW_SECRET=$(openssl rand -hex 32)
security add-generic-password -a remotedev -s remotedev-client-secret -w "$NEW_SECRET"
echo "New secret: $NEW_SECRET"

# 3. Update iPhone Safari password manager with the new secret

# 4. Restart with new secret in environment
REMOTEDEV_CLIENT_SECRET="$NEW_SECRET" ./bin/reload
```

---

## TLS Certificate Renewal

Tailscale certificates expire after 90 days. The bridge warns you:

| Days remaining | Bridge behavior |
|---|---|
| 14 days | `WARN` log: "TLS certificate expires in <14 days" |
| 7 days | `WARN` log: "TLS certificate expires in <7 days" |
| 3 days | `WARN` log: "TLS certificate expires in <3 days" |
| < 24 hours | Bridge **refuses to start** |

To renew:
```bash
tailscale cert mac.tail1234.ts.net
./bin/reload
```

Set up a launchd job or cron to auto-renew:
```bash
# Renew 7 days before expiry (run daily)
# Check expiry and renew if needed:
openssl x509 -enddate -noout -in /var/lib/tailscale/certs/mac.tail1234.ts.net.crt | \
  awk -F= '{print $2}' | xargs -I{} date -jf "%b %e %H:%M:%S %Y %Z" "{}" +%s | \
  xargs -I{} sh -c '[ $(date +%s) -gt $(({} - 604800)) ] && tailscale cert mac.tail1234.ts.net'
```

---

## Warning Banners

The UI shows banners for the following conditions:

| Banner | Meaning | Action |
|---|---|---|
| **Connection is slow — buffering output** (`client_slow`) | Bridge has been paused >30s waiting for your connection to drain. Output is buffering. | Check cellular signal; if it persists >60s the connection will be dropped and reconnected automatically |
| **Output parse errors — streaming raw lines** (`parse_degraded`) | Claude's output has 5+ consecutive JSON parse errors. Bridge is streaming raw stdout. | Usually a claude CLI version issue; check `pm2 logs remotedev-bridge`; update claude if needed |
| **Database write failed** (`persistence_degraded`) | SQLite writes are failing. Gap recovery will use the in-memory ring buffer only (last 200 messages). | Check disk space (`df -h`); check `pm2 logs remotedev-bridge` for the error |
| **Offline transcript limit reached** (`offline_budget_exceeded`) | This session has buffered 50MB of output while disconnected. Further output won't be saved to SQLite. | Reconnect and end the session; start a new one |
| **Session control taken by another tab** (`stale_epoch`) | Another browser tab authenticated and took controller access. Your tab has been disconnected. | Close other tabs; reload this one to re-authenticate |

---

## Troubleshooting

### "Can't connect / connection error"

1. Verify pm2 is running: `pm2 status`
2. Verify Tailscale is connected on both Mac and iPhone: `tailscale status`
3. Check the bridge started: `pm2 logs remotedev-bridge --lines 30`
4. Test connectivity: from iPhone Safari try `https://mac.tail1234.ts.net:7000` — if no TLS warning, the cert is good

### "Certificate warning in Safari"

The TLS cert doesn't match the hostname or has expired.
- Re-run: `tailscale cert mac.tail1234.ts.net`
- Then: `./bin/reload`

### "Authentication failed" (connection drops immediately)

- **Stale client secret:** The secret on iPhone doesn't match what's in Keychain. Re-run `./bin/reload` and update the iPhone password manager.
- **Token expired:** If you had a tab open for >30 seconds before connecting, the HMAC assertion expired. Reload the page to get a fresh token.
- **IP locked out:** 5 failed auth attempts triggered a 60-second lockout. Wait 60 seconds and try again.

### "Session is busy" when trying to send

A task is already running. Wait for it to complete, or tap **Stop** to end the current task.

### "Session not found" after reconnect

The session ended while you were disconnected (orphan timer fired after 5 minutes of no stdout, or the process exited). Start a new session — your previous output is in the transcript database.

### `parse_degraded` banner appears

Claude's output isn't valid JSON. Common causes:
- Claude CLI version mismatch: check `claude --version` vs `CLAUDE_MIN_VERSION`
- Claude CLI update changed output format: pin the version in `ecosystem.config.js`
- Very long output lines (>1MB): currently truncated

### Bridge won't start

Check logs: `pm2 logs remotedev-bridge --lines 50`

Common causes:
- `BRIDGE_AUTH_TOKEN is required` — environment variable not set; check `ecosystem.config.js`
- `TLS certificate expires in <24h` — cert expired; renew with `tailscale cert`
- `claude CLI version below minimum` — update claude: `npm update -g @anthropic-ai/claude-code`
- `EADDRINUSE: port 7001 already in use` — another process on that port; `lsof -i :7001` to find it

### Session doesn't end cleanly / stray claude processes

The orphan scanner runs every 5 minutes and will kill any `claude` processes with `REMOTEDEV_SESSION_ID` set that aren't tracked by the bridge. Wait up to 5 minutes, or run:

```bash
# Manual orphan scan (view only — don't pipe to kill without reviewing)
ps -eo pid,etime,command | grep 'claude.*stream-json'
```

### No output from Claude — PTY spawn failed

If the bridge logs contain `ptySpawnDiagnostics` with `ptyHelperExecutable: false`, the node-pty spawn-helper binary is missing its execute bit:

```bash
# Rebuild node-pty (sets the execute bit on spawn-helper)
cd bridge-server && npm install && cd ..

# Restart the bridge to pick up the fix
./bin/reload
```

You should see `Set node-pty spawn-helper executable` in the logs on the next start.

If you're on Linux, node-pty doesn't use a spawn-helper. Check that `LD_LIBRARY_PATH` and glibc compatibility are correct for your distribution.

### First instruction from iPhone is ignored

The UI disables the Send button while the WebSocket is connecting. If you submit an instruction very quickly after the page loads (before the green indicator appears), it may be queued while the connection is still establishing. Wait for the green indicator, then send.

### Approval modal never appears (tools run without asking)

This would indicate a misconfiguration in the approval flow. The bridge is designed to intercept every tool call and require explicit approval. Check that:
- You're on the latest bridge version (`./bin/reload` after a `git pull`)
- The bridge log shows `approval_requested` events for tool calls

---

## Security Notes

**Tailscale ACLs are the primary boundary.** Only devices you explicitly allow in ACLs can reach ports 7000 and 7001. Keep your ACLs narrow — only your iPhone, not `*`.

**The client secret is defense-in-depth.** If your Tailscale ACLs are misconfigured and someone reaches your bridge, the client secret is a second factor. Store it only in Keychain and iPhone password manager; never in plaintext files, shell history, or environment variables outside pm2.

**Bash approval defends against accidents, not prompt injection.** The "type APPROVE" requirement is deliberate friction to prevent you from accidentally approving destructive commands. It does not protect against a compromised Claude model generating a malicious command that you approve. Always read Bash commands before approving.

**Never approve commands you don't understand.** If you see a Bash command you didn't expect, deny it and check `pm2 logs remotedev-bridge` for what instruction triggered it.

**The bridge never logs your client secret or raw `BRIDGE_AUTH_TOKEN`.** These are handled via constant-time compare and HMAC respectively, and are never written to any log. If you suspect exposure, rotate both (see [Rotating the Client Secret](#rotating-the-client-secret)).

---

## Database

RemoteDev stores session history in SQLite at:

```
~/.local/share/remotedev/remotedev.db
```

- **Permissions:** `chmod 600` — readable only by your user
- **WAL mode:** Write-Ahead Logging for concurrent read/write without blocking
- **Retention:** 30 days (configurable via `RETENTION_DAYS` env var)
- **Tables:** `sessions`, `transcript`, `audit_log`, `client_errors`
- **VACUUM:** Runs at startup after retention pruning to reclaim disk space

To inspect:
```bash
sqlite3 ~/.local/share/remotedev/remotedev.db

# View recent sessions
SELECT id, name, state, datetime(created_at/1000, 'unixepoch') as created
FROM sessions ORDER BY created_at DESC LIMIT 10;

# View transcript for a session
SELECT seq, type, data, datetime(ts/1000, 'unixepoch') as time
FROM transcript WHERE session_id = '<id>' ORDER BY seq;

# View audit log
SELECT event, detail, datetime(ts/1000, 'unixepoch') as time
FROM audit_log ORDER BY ts DESC LIMIT 20;
```

To back up:
```bash
sqlite3 ~/.local/share/remotedev/remotedev.db ".backup /tmp/remotedev-backup.db"
```
