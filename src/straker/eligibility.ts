/**
 * Which language directions the team will take (FR-011, FR-011a).
 *
 * ## The rule, and the inference it rests on
 *
 * FR-011 says an offer is eligible when its direction is **any of the 44 the account is
 * registered for**, identified by the portal's own language identifiers. Nowhere in this
 * repository is there a list of those 44 — not in configuration, not in the recon note, not
 * in the captured payloads. What exists instead is a reasoned inference:
 *
 * > The portal only offers work in directions the account is registered for. So every
 * > direction that arrives **is by construction one of the 44**, and eligibility reduces to
 * > "this direction is not on the configured exclusion list".
 *
 * That is also what the spec's own design says in the other direction: `excludedLanguagePairs`
 * defaults to empty, and an empty exclusion list means all 44 are eligible. An allow-list
 * would need the 44 to be written down somewhere first, and inventing it from two independent
 * payloads would refuse real work the account is signed up for — the expensive direction of
 * this mistake, since an offer refused is gone in a few minutes (the shortest observed
 * contested window was 204 seconds).
 *
 * **The inference is recorded here because it is an inference.** It is load-bearing and it is
 * unverified. If the portal ever starts offering directions the account is not registered for,
 * or changes how it names a language, this module silently keeps saying "eligible". That is
 * why {@link isFamiliarDirectionShape} exists: `offerParse` calls it on every offer and logs
 * loudly when a direction is shaped unlike anything the sample showed, so the assumption is
 * observable in the log rather than only in this comment. It deliberately does NOT gate
 * eligibility — an unfamiliar shape is reported, never refused.
 *
 * ## The portal's identifiers, inconsistency included
 *
 * The captured payloads carry `source_lang` / `target_lang` as lower-case, hyphenated tags —
 * and inconsistently regioned: `th` has no region while `ms-my` and `zh-tw` do. We accept the
 * inconsistency and never normalise `th` towards `th-th`, because a padded tag would match
 * nothing the portal ever sends and no exclusion written against it would ever fire.
 */

/** How a direction is written, in the record and in `STRAKER_EXCLUDED_LANGUAGE_PAIRS`. */
export const DIRECTION_SEPARATOR = '>';

/**
 * The shapes the two independent captured jobs used: a 2-3 letter language, optionally a
 * hyphen and a 2-3 letter region. `en-us`, `ms-my`, `zh-tw`, `th`.
 *
 * Anything else is *unfamiliar*, not *invalid* — this is a tripwire on a thin sample, not a
 * specification of what Straker may send.
 */
const FAMILIAR_TAG = /^[a-z]{2,3}(-[a-z]{2,3})?$/;

/** Lower-cased and trimmed, so no comparison anywhere turns on the portal's casing. */
export function normalizeLanguageTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/** `source>target`, in the portal's own identifiers — never display names (FR-011). */
/**
 * Is this direction the same language on both sides?
 *
 * That is what DTP preparation looks like once it is written down: the portal sends
 * `target_lang: null` on the offer, the assigned-jobs endpoint reports `ja>ja` for the same
 * work, and both arrive here as one string. Kept beside the formatter so the two can never
 * disagree about what a direction is.
 */
export function isMonolingualDirection(direction: string): boolean {
  const [source, target] = normalizeLanguageTag(direction).split(DIRECTION_SEPARATOR);
  return source !== undefined && source === target;
}

export function formatLanguageDirection(sourceLang: string, targetLang: string): string {
  return `${normalizeLanguageTag(sourceLang)}${DIRECTION_SEPARATOR}${normalizeLanguageTag(targetLang)}`;
}

/**
 * Eligible unless excluded. See the inference at the top of this file for why the rule is
 * negative rather than an allow-list of 44.
 *
 * Both sides are normalised rather than trusting `loadStrakerBotConfig` to have lower-cased
 * the list: eligibility that depends on a caller's hygiene is eligibility that breaks the
 * first time it is called from somewhere new, and the cost of being wrong is an irreversible
 * claim in a language the crew cannot staff.
 */
export function isEligibleDirection(
  direction: string,
  excludedLanguagePairs: readonly string[],
): boolean {
  const wanted = normalizeLanguageTag(direction);
  // Exact match only. A substring test would let an exclusion of `th` swallow every
  // direction that merely mentions Thai, including ones the team does take.
  return !excludedLanguagePairs.some((pair) => normalizeLanguageTag(pair) === wanted);
}

/**
 * Whether a direction looks like the ones the capture probe actually saw.
 *
 * Not an eligibility test — `offerParse` logs on a false and carries on. The point is that
 * the day the portal changes how it names a language, that shows up in the log as a warning
 * instead of showing up in the record as a claim in an unexpected language.
 */
export function isFamiliarDirectionShape(direction: string): boolean {
  const parts = normalizeLanguageTag(direction).split(DIRECTION_SEPARATOR);
  return parts.length === 2 && parts.every((tag) => FAMILIAR_TAG.test(tag));
}
