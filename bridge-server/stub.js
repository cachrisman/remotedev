'use strict';

/**
 * Bridge stub — emits canned sequences for Phase 2 parallel UI development.
 *
 * Simulates the bridge server without requiring a real claude process.
 * Supports: auth, create_session, input (canned responses), approval flow, stop;
 * Chat-Branch Policy: list_projects, add_project, select_project, list_chats, create_chat, switch_chat, archive_chat, switch_branch, remediate.
 *
 * Usage:
 *   BRIDGE_AUTH_TOKEN=test REMOTEDEV_CLIENT_SECRET=test node bridge-server/stub.js
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const auth = require('./auth');

const PORT = parseInt(process.env.BRIDGE_PORT || '7001', 10);
const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || 'stub-token';
const CLIENT_SECRET = process.env.REMOTEDEV_CLIENT_SECRET || 'stub-secret';
const PROTOCOL_VERSION = 1;

let seq = 0;
function nextSeq() { return ++seq; }

const stubProjects = [];
let stubActiveProjectPath = null;
const stubChats = [];
let stubActiveChatId = null;
let stubCurrentBranch = 'main';

function buildMsg(type, sessionId, payload, extraFields = {}) {
  return {
    v: PROTOCOL_VERSION,
    type,
    seq: nextSeq(),
    sessionId: sessionId || null,
    rootMessageId: null,
    messageId: crypto.randomUUID(),
    ts: Date.now(),
    payload: payload || null,
    controllerEpoch: null,
    ...extraFields,
  };
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Canned instruction responses
const CANNED_RESPONSES = [
  { delay: 500, text: 'Analyzing your request...' },
  { delay: 1000, text: 'Reading relevant files...' },
  { delay: 1500, text: 'Making changes...' },
  { delay: 2000, requestApproval: true },
  { delay: 3000, text: 'Finalizing changes.' },
  { delay: 3500, type: 'result', text: 'Done! Changes applied successfully.' },
];

function simulateInstruction(ws, sessionId, rootMessageId, instruction) {
  let timers = [];
  let requestId = null;
  let waitingApproval = false;

  const emit = (payload, delay, extraSeq = null) => {
    const t = setTimeout(() => {
      if (waitingApproval) return; // pause stream while waiting
      send(ws, {
        ...buildMsg('output', sessionId, payload),
        rootMessageId,
        seq: extraSeq || nextSeq(),
      });
    }, delay);
    timers.push(t);
  };

  CANNED_RESPONSES.forEach((step, i) => {
    const t = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) return;

      if (step.requestApproval) {
        requestId = crypto.randomUUID();
        waitingApproval = true;
        send(ws, {
          ...buildMsg('output', sessionId, {
            type: 'control_request',
            requestId,
            data: {
              type: 'tool_use',
              name: 'Bash',
              id: requestId,
              input: { command: 'echo "Hello from RemoteDev stub"' },
            },
            expiresAt: Date.now() + 60000,
          }),
          rootMessageId,
        });

        // State sync for AWAITING_APPROVAL
        send(ws, buildMsg('state_sync', sessionId, {
          state: 'AWAITING_APPROVAL',
          sessionId,
          seq: nextSeq(),
          pendingApproval: { requestId, data: {}, expiresAt: Date.now() + 60000 },
        }));
        return;
      }

      if (step.type === 'result') {
        send(ws, {
          ...buildMsg('output', sessionId, { type: 'result', result: step.text }),
          rootMessageId,
        });
        // Session end
        setTimeout(() => {
          send(ws, buildMsg('exit', sessionId, { reason: 'proc_exit:0' }));
          send(ws, buildMsg('state_sync', sessionId, { state: 'IDLE', sessionId, seq: nextSeq() }));
        }, 500);
        return;
      }

      send(ws, {
        ...buildMsg('output', sessionId, { type: 'text', text: step.text }),
        rootMessageId,
      });
    }, step.delay);
    timers.push(t);
  });

  return {
    handleApproval(decision) {
      waitingApproval = false;
      send(ws, buildMsg('state_sync', sessionId, {
        state: 'RUNNING',
        sessionId,
        seq: nextSeq(),
        pendingApproval: null,
      }));

      const resultText = decision === 'approve'
        ? 'Bash executed: Hello from RemoteDev stub'
        : 'Bash execution denied.';

      setTimeout(() => {
        send(ws, {
          ...buildMsg('output', sessionId, { type: 'text', text: resultText }),
          rootMessageId,
        });
      }, 500);
    },
    stop() {
      timers.forEach(clearTimeout);
    },
  };
}

const server = http.createServer();
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress || 'unknown';
  let isAuthed = false;
  let sessionId = null;
  let epoch = null;
  let currentTask = null;

  const authTimeout = setTimeout(() => {
    if (!isAuthed) ws.close(4008, 'auth_timeout');
  }, 5000);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (!isAuthed) {
      if (msg.type !== 'authenticate') { ws.close(4003, 'not_authenticated'); return; }

      const result = auth.validateAuthenticate(
        msg.payload || msg, BRIDGE_AUTH_TOKEN, CLIENT_SECRET
      );
      if (!result.ok) { ws.close(4003, result.reason); return; }

      clearTimeout(authTimeout);
      isAuthed = true;
      epoch = crypto.randomUUID();

      send(ws, { ...buildMsg('authenticated', null, { controllerEpoch: epoch }), controllerEpoch: epoch });
      console.log('[stub] Client authenticated');
      return;
    }

    switch (msg.type) {
      case 'list_projects': {
        send(ws, buildMsg('state_sync', sessionId, {
          projects: stubProjects.map(p => ({ project_path: p, created_at: Date.now(), last_used_at: Date.now() })),
          activeProjectPath: stubActiveProjectPath,
          chats: stubChats.filter(c => c.projectPath === stubActiveProjectPath).map(c => ({ id: c.id, name: c.name, current_branch: c.currentBranch, chat_status: c.chatStatus })),
          activeChatId: stubActiveChatId,
          currentBranch: stubCurrentBranch,
        }));
        break;
      }
      case 'add_project': {
        const projectPath = msg.payload?.projectPath;
        if (projectPath && !stubProjects.includes(projectPath)) stubProjects.push(projectPath);
        send(ws, buildMsg('state_sync', sessionId, {
          projects: stubProjects.map(p => ({ project_path: p, created_at: Date.now(), last_used_at: Date.now() })),
          activeProjectPath: stubActiveProjectPath,
        }));
        break;
      }
      case 'select_project': {
        stubActiveProjectPath = msg.payload?.projectPath || null;
        const chatsForProject = stubChats.filter(c => c.projectPath === stubActiveProjectPath);
        send(ws, buildMsg('state_sync', sessionId, {
          projects: stubProjects.map(p => ({ project_path: p, created_at: Date.now(), last_used_at: Date.now() })),
          activeProjectPath: stubActiveProjectPath,
          chats: chatsForProject.map(c => ({ id: c.id, name: c.name, current_branch: c.currentBranch, chat_status: c.chatStatus })),
          activeChatId: stubActiveChatId && chatsForProject.some(c => c.id === stubActiveChatId) ? stubActiveChatId : null,
        }));
        break;
      }
      case 'list_chats': {
        const pp = msg.payload?.projectPath || stubActiveProjectPath;
        const chats = stubChats.filter(c => c.projectPath === pp).map(c => ({ id: c.id, name: c.name, current_branch: c.currentBranch, chat_status: c.chatStatus }));
        send(ws, buildMsg('state_sync', sessionId, { projects: stubProjects.map(p => ({ project_path: p, created_at: Date.now(), last_used_at: null })), activeProjectPath: stubActiveProjectPath, chats }));
        break;
      }
      case 'create_chat': {
        const projectPath = msg.payload?.projectPath || stubActiveProjectPath;
        const name = (msg.payload?.name || 'chat').trim().slice(0, 40);
        sessionId = crypto.randomUUID();
        stubActiveChatId = sessionId;
        const branch = 'chat/' + Date.now().toString(36) + '-' + name.slice(0, 8);
        stubChats.push({ id: sessionId, name, projectPath, currentBranch: branch, chatStatus: 'ACTIVE' });
        stubCurrentBranch = branch;
        send(ws, buildMsg('state_sync', sessionId, {
          state: 'IDLE', sessionId, seq: nextSeq(), lastAck: 0,
          activeChatId: sessionId, currentBranch: branch,
          projects: stubProjects.map(p => ({ project_path: p, created_at: Date.now(), last_used_at: Date.now() })),
          activeProjectPath: stubActiveProjectPath,
          chats: stubChats.filter(c => c.projectPath === stubActiveProjectPath).map(c => ({ id: c.id, name: c.name, current_branch: c.currentBranch, chat_status: c.chatStatus })),
        }));
        console.log('[stub] Chat created:', sessionId);
        break;
      }
      case 'switch_chat': {
        const chatId = msg.payload?.chatId;
        const chat = stubChats.find(c => c.id === chatId);
        if (chat) {
          sessionId = chatId;
          stubActiveChatId = chatId;
          stubCurrentBranch = chat.currentBranch;
        }
        send(ws, buildMsg('state_sync', sessionId, {
          state: 'IDLE', sessionId, seq: nextSeq(), lastAck: 0,
          activeChatId: stubActiveChatId, currentBranch: stubCurrentBranch,
          projects: stubProjects.map(p => ({ project_path: p, created_at: Date.now(), last_used_at: null })),
          activeProjectPath: stubActiveProjectPath,
          chats: stubChats.filter(c => c.projectPath === stubActiveProjectPath).map(c => ({ id: c.id, name: c.name, current_branch: c.currentBranch, chat_status: c.chatStatus })),
        }));
        break;
      }
      case 'switch_branch': {
        const branchName = msg.payload?.branchName;
        if (branchName) stubCurrentBranch = branchName;
        const chat = stubChats.find(c => c.id === sessionId);
        if (chat) chat.currentBranch = stubCurrentBranch;
        send(ws, buildMsg('state_sync', sessionId, { state: 'IDLE', sessionId, seq: nextSeq(), currentBranch: stubCurrentBranch }));
        break;
      }
      case 'archive_chat': {
        const chatId = msg.payload?.chatId;
        const c = stubChats.find(x => x.id === chatId);
        if (c) c.chatStatus = 'ARCHIVED';
        if (stubActiveChatId === chatId) stubActiveChatId = null;
        send(ws, buildMsg('state_sync', sessionId, {
          activeChatId: stubActiveChatId,
          chats: stubChats.filter(x => x.projectPath === stubActiveProjectPath && x.chatStatus !== 'ARCHIVED').map(x => ({ id: x.id, name: x.name, current_branch: x.currentBranch, chat_status: x.chatStatus })),
        }));
        break;
      }
      case 'remediate': {
        const chatId = msg.payload?.chatId;
        send(ws, buildMsg('remediate_result', chatId, { safe: true, stagedCount: 0, unstagedCount: 0, untrackedCount: 0, truncated: false }));
        break;
      }
      case 'create_session': {
        sessionId = crypto.randomUUID();
        send(ws, buildMsg('state_sync', sessionId, {
          state: 'IDLE', sessionId, seq: nextSeq(), lastAck: 0,
        }));
        console.log('[stub] Session created:', sessionId);
        break;
      }

      case 'input': {
        if (!sessionId) break;
        const rootMessageId = msg.payload?.messageId || crypto.randomUUID();
        send(ws, buildMsg('state_sync', sessionId, { state: 'RUNNING', sessionId, seq: nextSeq() }));
        currentTask = simulateInstruction(ws, sessionId, rootMessageId, msg.payload?.instruction || '');
        console.log('[stub] Input received:', msg.payload?.instruction?.slice(0, 50));
        break;
      }

      case 'approval_response': {
        if (currentTask) {
          currentTask.handleApproval(msg.payload?.decision || 'deny');
        }
        break;
      }

      case 'stop': {
        if (currentTask) currentTask.stop();
        send(ws, buildMsg('exit', sessionId, { reason: 'stop' }));
        send(ws, buildMsg('state_sync', sessionId, { state: 'IDLE', sessionId, seq: nextSeq() }));
        break;
      }

      case 'ping': {
        send(ws, buildMsg('pong', sessionId, { seq: nextSeq() }));
        break;
      }

      case 'resume_session': {
        send(ws, buildMsg('state_sync', sessionId, { state: 'IDLE', sessionId, seq: nextSeq() }));
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentTask) currentTask.stop();
    console.log('[stub] Client disconnected');
  });
});

server.listen(PORT, () => {
  console.log(`[stub] Bridge stub listening on ws://localhost:${PORT}`);
});
