/**
 * Acceptance eligibility (R8, FR-006/FR-007). Pure: maps a job's target language
 * to "should the bot accept this", driven entirely by the configured language
 * list (`ACCEPT_LANGUAGES`, default `Malay (Malaysia)`) — nothing is hard-coded
 * here so the eligible set changes by config, not code.
 *
 * Matching is an EXACT token match (trim + case-insensitive), never a substring,
 * so "Malay" does not match "Malay (Malaysia)" and a non-Malay language is never
 * accidentally accepted. A null/unreadable target is never eligible — the bot
 * never accepts on uncertainty (the parser fails loud on an unrecognized
 * language elsewhere; here the safe default is "skip").
 */
export function isEligibleTarget(targetLang: string | null, acceptLanguages: string[]): boolean {
  if (targetLang === null) return false;
  const norm = targetLang.trim().toLowerCase();
  if (norm === '') return false;
  return acceptLanguages.some((l) => l.trim().toLowerCase() === norm);
}
