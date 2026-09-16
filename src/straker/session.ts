/**
 * Straker login for the Phase 0 probe. Read-only: it opens a session and learns which
 * vendor the session belongs to, nothing else.
 */

import type { EssentialDoor } from './httpClient.js';

export interface StrakerCredentials {
  readonly loginId: string;
  readonly password: string;
  /** Present only once Straker's 2FA is switched on; the field already exists server-side. */
  readonly totpCode?: string;
}

export interface StrakerSession {
  readonly vendorId: string;
}

/**
 * The vendor id is read from `/auth/me` (`member_obj_id`) on every login rather than
 * pinned in config: recon §2 notes it changes under impersonation or an account switch,
 * and a stale id would silently poll somebody else's offer list.
 */
export async function openSession(
  // Narrowed to the **essential** door, the same way `ClaimDoor` narrows the claim path —
  // and here the narrowing carries a behaviour, not only a guarantee. Pacing classifies a
  // request by the door it came through, and `/auth/me` used to arrive on the deferrable
  // one: a session that expired exactly when the request allowance ran low could then not
  // be renewed, leaving the bot blind for up to a window for want of one request. Sign-in
  // is what every other request depends on, so it belongs beside the claim.
  client: EssentialDoor,
  credentials: StrakerCredentials,
): Promise<StrakerSession> {
  const body: Record<string, string> = {
    login_id: credentials.loginId,
    password: credentials.password,
  };
  if (credentials.totpCode !== undefined) body['totp_code'] = credentials.totpCode;

  await client.postJson('/api/vendor/auth/login', body);
  const me = await client.getJson<{ member_obj_id?: unknown }>('/api/vendor/auth/me');

  if (typeof me.member_obj_id !== 'string' || me.member_obj_id === '') {
    throw new Error('Straker /auth/me returned no member_obj_id — cannot resolve vendor id');
  }
  return { vendorId: me.member_obj_id };
}
