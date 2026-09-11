import { describe, expect, it, vi } from 'vitest';
import { openSession } from '../../../src/straker/session.js';
import type { StrakerHttpClient } from '../../../src/straker/httpClient.js';

function client(overrides: Partial<StrakerHttpClient> = {}): StrakerHttpClient {
  return {
    getJson: vi.fn().mockResolvedValue({ member_obj_id: 'vendor-from-me' }),
    // Present because the transport has it; signing in never retries a read.
    getJsonWithBackoff: vi.fn(),
    postJson: vi.fn().mockResolvedValue({}),
    lastRateLimit: () => null,
    ...overrides,
  };
}

describe('openSession', () => {
  it('resolves the vendor id from /auth/me so it is never hardcoded', async () => {
    const c = client();

    const session = await openSession(c, { loginId: 'user@example.test', password: 'pw' });

    expect(session.vendorId).toBe('vendor-from-me');
    expect(c.getJson).toHaveBeenCalledWith('/api/vendor/auth/me');
  });

  it('leaves totp_code out of the login body when no code is configured', async () => {
    const postJson = vi.fn().mockResolvedValue({});
    const c = client({ postJson });

    await openSession(c, { loginId: 'user@example.test', password: 'pw' });

    expect(postJson).toHaveBeenCalledWith('/api/vendor/auth/login', {
      login_id: 'user@example.test',
      password: 'pw',
    });
  });

  it('sends totp_code when one is configured, ready for the day 2FA is switched on', async () => {
    const postJson = vi.fn().mockResolvedValue({});
    const c = client({ postJson });

    await openSession(c, { loginId: 'u', password: 'pw', totpCode: '123456' });

    expect(postJson).toHaveBeenCalledWith('/api/vendor/auth/login', {
      login_id: 'u',
      password: 'pw',
      totp_code: '123456',
    });
  });
});
