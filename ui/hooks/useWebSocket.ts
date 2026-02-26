'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const PROTOCOL_VERSION = 1;
const BRIDGE_WS_URL = process.env.NEXT_PUBLIC_BRIDGE_WS_URL || 'wss://localhost:7001';
const CLIENT_SECRET = process.env.NEXT_PUBLIC_CLIENT_SECRET || '';
const UI_BUILD_VERSION = process.env.UI_BUILD_VERSION || 'unknown';

// Jittered reconnect backoff for 1011 (buffer overflow)
function jitterMs(min = 200, max = 1000) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'error';

export interface BridgeMessage {
  v: number;
  type: string;
  seq: number | null;
  sessionId: string | null;
  rootMessageId: string | null;
  messageId: string;
  ts: number;
  payload: Record<string, unknown> | null;
  controllerEpoch: string | null;
}

interface UseWebSocketOptions {
  onMessage?: (msg: BridgeMessage) => void;
  sessionId?: string | null;
  controllerEpoch?: string | null;
}

export interface UseWebSocketReturn {
  connectionState: ConnectionState;
  send: (msg: Partial<BridgeMessage>) => void;
  controllerEpoch: string | null;
}

export function useWebSocket({
  onMessage,
  sessionId,
  controllerEpoch: externalEpoch,
}: UseWebSocketOptions = {}): UseWebSocketReturn {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [controllerEpoch, setControllerEpoch] = useState<string | null>(externalEpoch || null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cachedTokenRef = useRef<{ wsAuth: string; nonce: string; ts: number } | null>(null);
  const failureCountRef = useRef(0);
  const destroyedRef = useRef(false);
  const epochRef = useRef<string | null>(controllerEpoch);
  const sessionIdRef = useRef<string | null>(sessionId || null);
  const lastAckRef = useRef(0);

  useEffect(() => {
    epochRef.current = controllerEpoch;
  }, [controllerEpoch]);

  useEffect(() => {
    sessionIdRef.current = sessionId || null;
  }, [sessionId]);

  const fetchToken = useCallback(async (): Promise<{
    wsAuth: string;
    nonce: string;
    ts: number;
  }> => {
    const res = await fetch('/api/token');
    if (!res.ok) throw new Error('Failed to fetch token');
    return res.json();
  }, []);

  const connect = useCallback(async () => {
    if (destroyedRef.current) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    setConnectionState('connecting');

    let token = cachedTokenRef.current;
    if (!token) {
      try {
        token = await fetchToken();
        cachedTokenRef.current = token;
      } catch {
        setConnectionState('error');
        scheduleReconnect(2000);
        return;
      }
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(BRIDGE_WS_URL);
    } catch {
      setConnectionState('error');
      scheduleReconnect(2000);
      return;
    }

    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionState('authenticating');
      // Send authenticate message
      ws.send(JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'authenticate',
        messageId: crypto.randomUUID(),
        ts: Date.now(),
        payload: {
          wsAuth: token!.wsAuth,
          nonce: token!.nonce,
          ts: token!.ts,
          clientSecret: CLIENT_SECRET,
        },
      }));
    };

    ws.onmessage = (event) => {
      let msg: BridgeMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === 'authenticated') {
        const epoch = (msg.payload?.controllerEpoch as string) || null;
        setControllerEpoch(epoch);
        epochRef.current = epoch;
        setConnectionState('connected');
        failureCountRef.current = 0;

        // If we have a session, send resume_session
        if (sessionIdRef.current) {
          sendInternal(ws, epoch, {
            type: 'resume_session',
            sessionId: sessionIdRef.current,
            payload: { sessionId: sessionIdRef.current },
          });
        }
        return;
      }

      // Protocol version mismatch
      if (msg.v !== undefined && msg.v !== PROTOCOL_VERSION) {
        ws.close(4400, 'protocol_version_mismatch');
        return;
      }

      // Update lastAck from pong
      if (msg.type === 'pong' && msg.payload?.seq != null) {
        lastAckRef.current = msg.payload.seq as number;
      }

      onMessage?.(msg);
    };

    ws.onclose = (event) => {
      wsRef.current = null;
      const code = event.code;

      if (destroyedRef.current) return;

      if (code === 4003) {
        // Token desync (e.g., after ./bin/reload) — clear cached token and retry
        // Do NOT increment failure counter
        cachedTokenRef.current = null;
        setConnectionState('connecting');
        scheduleReconnect(500);
        return;
      }

      if (code === 1011) {
        // Buffer overflow — bridge kept session; reconnect immediately with jitter
        setConnectionState('connecting');
        scheduleReconnect(jitterMs(200, 1000));
        return;
      }

      if (code === 4400 || code === 4403) {
        // Protocol mismatch or stale epoch — reconnect cleanly
        cachedTokenRef.current = null;
        setConnectionState('error');
        scheduleReconnect(2000);
        return;
      }

      if (code === 1000 || code === 1001) {
        // Normal close
        setConnectionState('disconnected');
        return;
      }

      // Unexpected close — retry with backoff
      failureCountRef.current++;
      const backoff = Math.min(1000 * Math.pow(2, failureCountRef.current - 1), 30000);
      setConnectionState('error');
      scheduleReconnect(backoff);
    };

    ws.onerror = () => {
      // onerror is always followed by onclose; handle there
    };
  }, [fetchToken, onMessage]);

  const scheduleReconnect = useCallback((ms: number) => {
    if (destroyedRef.current) return;
    clearTimeout(reconnectTimerRef.current!);
    reconnectTimerRef.current = setTimeout(() => {
      if (!destroyedRef.current) connect();
    }, ms);
  }, [connect]);

  const sendInternal = (
    ws: WebSocket,
    epoch: string | null,
    partial: Partial<BridgeMessage> & { type: string }
  ) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const msg: BridgeMessage = {
      v: PROTOCOL_VERSION,
      type: partial.type,
      seq: null,
      sessionId: partial.sessionId || sessionIdRef.current,
      rootMessageId: partial.rootMessageId || null,
      messageId: crypto.randomUUID(),
      ts: Date.now(),
      payload: partial.payload || null,
      controllerEpoch: epoch || epochRef.current,
    };
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  };

  const send = useCallback((partial: Partial<BridgeMessage> & { type: string }) => {
    if (!wsRef.current) return;
    sendInternal(wsRef.current, epochRef.current, partial);
  }, []);

  // Handle visibilitychange — reconnect immediately when tab becomes visible
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          connect();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [connect]);

  // Initial connection
  useEffect(() => {
    destroyedRef.current = false;
    connect();
    return () => {
      destroyedRef.current = true;
      clearTimeout(reconnectTimerRef.current!);
      wsRef.current?.close(1000, 'unmount');
    };
  }, [connect]);

  // Send periodic pings
  useEffect(() => {
    const interval = setInterval(() => {
      send({ type: 'ping', payload: { lastAck: lastAckRef.current } });
    }, 20000);
    return () => clearInterval(interval);
  }, [send]);

  return { connectionState, send, controllerEpoch };
}
