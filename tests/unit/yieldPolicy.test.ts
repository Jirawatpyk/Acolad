import { describe, it, expect } from 'vitest';
import {
  classifyLogout,
  shouldYieldOnLogout,
  inCooldown,
  yieldStuck,
} from '../../src/runtime/yieldPolicy.js';

describe('classifyLogout', () => {
  it('detects a competing login from the logout.jsp type param', () => {
    expect(
      classifyLogout(
        'https://xtm.acolad.com/project-manager-gui/logout.jsp?type=LOGGED_OFF_BY_ANOTHER_USER',
      ),
    ).toBe('kicked_by_other');
  });
  it('detects a genuine session expiry', () => {
    expect(
      classifyLogout('https://xtm.acolad.com/project-manager-gui/logout.jsp?type=SESSION_EXPIRED'),
    ).toBe('expired');
  });
  it('is case-insensitive on the type value', () => {
    expect(classifyLogout('https://x/logout.jsp?type=logged_off_by_another_user')).toBe(
      'kicked_by_other',
    );
  });
  it('returns unknown for an unrecognised or missing type', () => {
    expect(classifyLogout('https://xtm.acolad.com/project-manager-gui/login.jsp')).toBe('unknown');
    expect(classifyLogout('')).toBe('unknown');
  });
});

describe('shouldYieldOnLogout', () => {
  const base = { lastAuthSuccessMs: 1_000_000, nowMs: 1_000_000 + 5_000, windowMs: 600_000 };
  it('always yields when kicked by another user (deterministic)', () => {
    expect(shouldYieldOnLogout({ ...base, kind: 'kicked_by_other' })).toBe(true);
  });
  it('yields on expiry only when authenticated within the window', () => {
    expect(shouldYieldOnLogout({ ...base, kind: 'expired' })).toBe(true); // 5s ago < 600s
  });
  it('does NOT yield on expiry when the last success is older than the window', () => {
    expect(
      shouldYieldOnLogout({
        kind: 'expired',
        lastAuthSuccessMs: 1_000_000,
        nowMs: 2_000_000,
        windowMs: 600_000,
      }),
    ).toBe(false);
  });
  it('does NOT yield on a cold start (no prior success)', () => {
    expect(
      shouldYieldOnLogout({
        kind: 'unknown',
        lastAuthSuccessMs: 0,
        nowMs: 5_000,
        windowMs: 600_000,
      }),
    ).toBe(false);
  });
});

describe('inCooldown', () => {
  it('is true before the deadline, false at/after it', () => {
    expect(inCooldown(2_000, 1_999)).toBe(true);
    expect(inCooldown(2_000, 2_000)).toBe(false);
    expect(inCooldown(0, 1)).toBe(false); // 0 = not yielding
  });
});

describe('yieldStuck', () => {
  it('is true once the episode has run for >= maxMinutes', () => {
    expect(yieldStuck(0, 9_999_999, 60)).toBe(false); // episode 0 = not yielding
    expect(yieldStuck(1_000, 1_000 + 60 * 60_000 - 1, 60)).toBe(false);
    expect(yieldStuck(1_000, 1_000 + 60 * 60_000, 60)).toBe(true);
  });
});
