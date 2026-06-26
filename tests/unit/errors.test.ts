import { describe, it, expect } from 'vitest';
import { classifyLogout } from '../../src/portal/errors.js';

/**
 * classifyLogout parses XTM's `logout.jsp?type=…` URL — portal-domain knowledge, so it
 * lives next to LogoutKind/SessionYieldError in src/portal/errors.ts (F8/F9: moved out of
 * the runtime layer to remove the portal→runtime import inversion). The type matcher is
 * anchored so a prefixed code cannot false-match (F8).
 */
describe('classifyLogout (portal logout-URL parsing)', () => {
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

  it('does not match type= in a path segment (no query boundary)', () => {
    expect(classifyLogout('https://x/path/sometype=LOGGED_OFF_BY_ANOTHER_USER')).toBe('unknown');
  });

  it('matches when the type param is followed by another query param (& boundary)', () => {
    expect(classifyLogout('https://x/logout.jsp?type=SESSION_EXPIRED&next=/inbox')).toBe('expired');
    expect(classifyLogout('https://x/logout.jsp?type=LOGGED_OFF_BY_ANOTHER_USER&x=1')).toBe(
      'kicked_by_other',
    );
  });

  it('does NOT false-match a prefixed code thanks to the anchor (F8)', () => {
    // Without the (?:&|$) anchor, `type=SESSION_EXPIRED_FORCED` would substring-match
    // SESSION_EXPIRED and be misread as a genuine expiry. The anchor keeps it unknown.
    expect(classifyLogout('https://x/logout.jsp?type=SESSION_EXPIRED_FORCED')).toBe('unknown');
    expect(classifyLogout('https://x/logout.jsp?type=LOGGED_OFF_BY_ANOTHER_USER_X')).toBe(
      'unknown',
    );
  });
});
