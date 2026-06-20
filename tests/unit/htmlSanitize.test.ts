import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from '../../src/portal/htmlSanitize.js';

/**
 * FR-012 / Constitution V: captured evidence must never carry live credentials.
 * Covers the leak the review flagged — the XTM session token #uust (loggedInToken)
 * was written verbatim — plus password fields and configured secret strings.
 */
describe('sanitizeHtml', () => {
  it('masks the session token (#uust) and CSRF build id (#xcbid) input values', () => {
    const html =
      '<input id="uust" value="vkbn6c3uu22lsnrqfsq7fh263nbepmd2">' +
      '<input id="xcbid" value="build-99887766">';
    const out = sanitizeHtml(html, []);
    expect(out).not.toContain('vkbn6c3uu22lsnrqfsq7fh263nbepmd2');
    expect(out).not.toContain('build-99887766');
    expect(out).toContain('id="uust" value="[REDACTED]"');
    expect(out).toContain('id="xcbid" value="[REDACTED]"');
  });

  it('masks password/email field values and ng-model password decoys', () => {
    const html =
      '<input type="password" value="hunter2">' +
      '<input type="email" value="a@b.com">' +
      '<input type="hidden" ng-model="loginCtrl.formData.autocompletePassword" value="leak">';
    const out = sanitizeHtml(html, []);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('a@b.com');
    expect(out).not.toContain('"leak"');
  });

  it('scrubs configured concrete secret strings anywhere in the markup', () => {
    const html = '<div>company=AMPLEXOR pw=S3cr3tP@ss</div>';
    const out = sanitizeHtml(html, ['AMPLEXOR', 'S3cr3tP@ss']);
    expect(out).toBe('<div>company=[REDACTED] pw=[REDACTED]</div>');
  });

  it('leaves non-sensitive inputs and content untouched', () => {
    const html = '<input id="client" value="visible"><p>ordinary text</p>';
    const out = sanitizeHtml(html, []);
    expect(out).toContain('id="client" value="visible"'); // not a secret field
    expect(out).toContain('ordinary text');
  });
});
