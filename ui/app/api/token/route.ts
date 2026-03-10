// force-dynamic: guarantee fresh nonce+ts on every request (never cached)
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import crypto from 'crypto';

const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN;
// Server-side only — never exposed as NEXT_PUBLIC_ so it isn't baked into the bundle.
// Clients fetch these at runtime so the app works without a rebuild when secrets rotate.
const CLIENT_SECRET = process.env.REMOTEDEV_CLIENT_SECRET;
const BRIDGE_WS_URL = process.env.BRIDGE_WS_URL || 'wss://localhost:7001';
const ALLOWED_ROOTS = (process.env.ALLOWED_ROOTS || '').split(':').filter(Boolean);

export async function GET() {
  if (!BRIDGE_AUTH_TOKEN || !CLIENT_SECRET) {
    return NextResponse.json({ error: 'Server not configured' }, { status: 500 });
  }

  const nonce = crypto.randomUUID();
  const ts = Date.now();
  const wsAuth = crypto
    .createHmac('sha256', BRIDGE_AUTH_TOKEN)
    .update(`${nonce}:${ts}`)
    .digest('hex');

  // Return wsAuth, nonce, ts — NEVER the raw BRIDGE_AUTH_TOKEN.
  // clientSecret and bridgeWsUrl are runtime config, not build-time constants.
  return NextResponse.json({ wsAuth, nonce, ts, clientSecret: CLIENT_SECRET, bridgeWsUrl: BRIDGE_WS_URL, allowedRoots: ALLOWED_ROOTS });
}
