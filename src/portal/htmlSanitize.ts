/**
 * Sanitize captured portal HTML before it is written to evidence (FR-012,
 * Constitution V). Two passes: (1) mask the value of any input whose type or
 * identity marks it sensitive — password/email fields AND session/CSRF tokens
 * such as `#uust` (loggedInToken) and `#xcbid` (csrfBuildId), which are live
 * credentials; (2) scrub any configured concrete secret string anywhere in the
 * markup. No dependencies, so recon/diagnostic scripts can reuse it too.
 */
const SENSITIVE_ID =
  /(?:id|name|ng-model)=["'][^"']*(?:uust|xcbid|password|token|csrf|session|cookie)[^"']*["']/i;
const SENSITIVE_TYPE = /type=["'](?:password|email)["']/i;

export function sanitizeHtml(html: string, secrets: string[]): string {
  let out = html.replace(/<input\b[^>]*>/gi, (tag) => {
    const sensitive = SENSITIVE_TYPE.test(tag) || SENSITIVE_ID.test(tag);
    return sensitive ? tag.replace(/(\bvalue=["'])[^"']*(["'])/i, '$1[REDACTED]$2') : tag;
  });
  for (const s of secrets) {
    if (s && out.includes(s)) out = out.split(s).join('[REDACTED]');
  }
  return out;
}
