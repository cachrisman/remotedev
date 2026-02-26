'use strict';

const crypto = require('crypto');
const logger = require('./logger');

/**
 * SessionManager — global singleton for session lifecycle and controller epoch management.
 *
 * controllerEpoch is stored here (not per-session) as specified in v0.16:
 * when a new controller authenticates, a fresh UUID is minted. All mutating
 * C→S messages must include the current epoch.
 */
class SessionManager {
  #sessions = new Map(); // id → Session
  #currentEpoch = null;
  #controllerSessionId = null;

  create(SessionClass, id, name, workingDir) {
    const s = new SessionClass(id, name, workingDir);
    this.#sessions.set(id, s);
    return s;
  }

  get(id) {
    return this.#sessions.get(id) || null;
  }

  remove(id) {
    this.#sessions.delete(id);
  }

  allSessions() {
    return [...this.#sessions.values()];
  }

  activeCount() {
    return [...this.#sessions.values()].filter(s => s.state !== 'IDLE').length;
  }

  activePids() {
    return this.#sessions.values()
      .filter(s => s.proc && !s.proc.killed)
      .map(s => s.proc.pid)
      .filter(Boolean);
  }

  // Controller epoch management (global, not per-session)
  mintEpoch() {
    this.#currentEpoch = crypto.randomUUID();
    logger.debug({ epoch: this.#currentEpoch }, 'New controller epoch minted');
    return this.#currentEpoch;
  }

  validateEpoch(epoch) {
    return epoch === this.#currentEpoch;
  }

  getCurrentEpoch() {
    return this.#currentEpoch;
  }

  // Controller session tracking
  hasActiveController() {
    return this.#controllerSessionId !== null;
  }

  setController(sessionId) {
    this.#controllerSessionId = sessionId;
  }

  releaseController(sessionId) {
    if (this.#controllerSessionId === sessionId) {
      this.#controllerSessionId = null;
    }
  }

  getControllerSessionId() {
    return this.#controllerSessionId;
  }
}

// Export singleton
module.exports = new SessionManager();
