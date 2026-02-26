// force-dynamic: guarantee fresh nonce+ts on every request (never cached)
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import crypto from 'crypto';

const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN;

export async function GET() {
  if (!BRIDGE_AUTH_TOKEN) {
    return NextResponse.json({ error: 'Bridge auth token not configured' }, { status: 500 });
  }

  const nonce = crypto.randomUUID();
  const ts = Date.now();
  const wsAuth = crypto
    .createHmac('sha256', BRIDGE_AUTH_TOKEN)
    .update(`${nonce}:${ts}`)
    .digest('hex');

  // Return wsAuth, nonce, ts — NEVER the raw BRIDGE_AUTH_TOKEN
  return NextResponse.json({ wsAuth, nonce, ts });
}
