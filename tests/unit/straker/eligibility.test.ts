import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DIRECTION_SEPARATOR,
  formatLanguageDirection,
  isEligibleDirection,
  isFamiliarDirectionShape,
} from '../../../src/straker/eligibility.js';

/**
 * T032 — the language-direction rule (FR-011, FR-011a, V3).
 *
 * The rule the spec settles on is a NEGATIVE one: eligibility spans **all 44 directions the
 * account is registered for**, and the portal only ever offers directions the account is
 * registered for — so every direction that arrives is by construction one of the 44, and
 * eligibility reduces to "not on the configured exclusion list". An empty exclusion list
 * therefore means everything is eligible, which is what `STRAKER_EXCLUDED_LANGUAGE_PAIRS`
 * defaulting to empty already encodes.
 *
 * **That reduction is an inference, not a fact**: the list of 44 exists nowhere in this repo
 * and cannot be derived from two independent payloads. What the tests below pin is the
 * consequence of being wrong about it — an unfamiliar direction must stay ELIGIBLE (the
 * inference says it is registered) while being loudly VISIBLE (`isFamiliarDirectionShape`
 * is false, and `offerParse` logs it). Silently refusing work we are registered for is the
 * failure this shape is chosen to avoid; silently claiming it is what the log prevents.
 *
 * The directions used here are read off the captured payloads rather than typed from
 * memory, so "the real identifiers are eligible" is a claim about the portal's output.
 */

const FIXTURE_DIR = join(process.cwd(), 'fixtures', 'straker', 'offers');

function capturedDirections(): { source: string; target: string }[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.json'))
    .map(
      (name) =>
        JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as Record<string, unknown>,
    )
    .map((offer) => ({
      source: String(offer['source_lang']),
      target: String(offer['target_lang']),
    }));
}

describe('formatLanguageDirection', () => {
  it('joins the portal’s own identifiers with the separator the exclusion list uses', () => {
    // Kills: composing the direction with any other separator, or from display names.
    expect(formatLanguageDirection('en-us', 'ms-my')).toBe('en-us>ms-my');
    expect(DIRECTION_SEPARATOR).toBe('>');
  });

  it('lower-cases and trims, so a comparison never turns on how the portal cased a tag', () => {
    // Kills: dropping the normalisation and comparing the portal's spelling verbatim.
    expect(formatLanguageDirection(' EN-US ', 'MS-MY')).toBe('en-us>ms-my');
  });

  it('keeps a region-less tag region-less', () => {
    // `th` has no region while `ms-my` and `zh-tw` do. The portal is inconsistent and we
    // accept the inconsistency rather than inventing `th-th`, which would match nothing.
    // Kills: any "normalisation" that pads a bare tag out to a region.
    expect(formatLanguageDirection('en-us', 'th')).toBe('en-us>th');
  });
});

describe('isEligibleDirection', () => {
  const directions = capturedDirections();

  it('is reading the captured payloads, so an empty sweep cannot pass as clean', () => {
    // Guard the guard: a loader that silently finds nothing would make every claim below
    // vacuously true. Three payloads are committed; only two are independent jobs.
    expect(directions.length).toBeGreaterThanOrEqual(3);
    expect(directions.map((d) => `${d.source}>${d.target}`)).toEqual(
      expect.arrayContaining(['en-us>th', 'en-us>ms-my', 'en-us>zh-tw']),
    );
  });

  it('treats every direction the portal actually sent as eligible when nothing is excluded', () => {
    // FR-011 with an empty exclusion list = all 44 registered directions are eligible.
    // Kills: an allow-list built from a guessed set of languages, which would refuse
    // real work the account is registered for.
    for (const { source, target } of directions) {
      expect(isEligibleDirection(formatLanguageDirection(source, target), [])).toBe(true);
    }
  });

  it('refuses a direction that is on the exclusion list', () => {
    // Kills: ignoring the exclusion list entirely.
    expect(isEligibleDirection('en-us>th', ['en-us>th'])).toBe(false);
  });

  it('refuses only the excluded pair, leaving its siblings claimable', () => {
    // Kills: excluding by source or by target alone. `aj-265` arrived as one job split
    // across `th` and `ms-my`; excluding one must not take the other with it.
    const excluded = ['en-us>th'];
    expect(isEligibleDirection('en-us>ms-my', excluded)).toBe(true);
    expect(isEligibleDirection('en-us>zh-tw', excluded)).toBe(true);
  });

  it('matches the pair exactly, never as a substring of another pair', () => {
    // Kills: `some(pair => direction.includes(pair))`. `en-us>th` is a prefix-ish
    // fragment of nothing real, but `th` alone would swallow `en-us>th` under `includes`.
    expect(isEligibleDirection('en-us>th', ['th'])).toBe(true);
    expect(isEligibleDirection('en-us>th-th', ['en-us>th'])).toBe(true);
  });

  it('is direction-sensitive: excluding the reverse pair does not exclude the forward one', () => {
    // Kills: comparing an unordered set of the two tags. en>th and th>en are different work.
    expect(isEligibleDirection('en-us>th', ['th>en-us'])).toBe(true);
    expect(isEligibleDirection('th>en-us', ['th>en-us'])).toBe(false);
  });

  it('matches whatever the portal’s casing, on both sides of the comparison', () => {
    // The config parser already lower-cases the exclusion list, but eligibility must not
    // DEPEND on that: a caller passing a raw value must still get a correct answer.
    // Kills: normalising only the direction, or only the list.
    expect(isEligibleDirection('EN-US>TH', ['en-us>th'])).toBe(false);
    expect(isEligibleDirection('en-us>th', [' EN-US>TH '])).toBe(false);
  });

  it('keeps an unfamiliar direction eligible, because arrival is what implies registration', () => {
    // The inference under test: the portal only offers what the account is registered for.
    // Refusing an unrecognised direction would silently drop work the team is signed up
    // for — so the strangeness is reported (below) rather than acted on.
    // Kills: a shape check used as an eligibility gate.
    expect(isEligibleDirection('en-us>zh-hant-tw', [])).toBe(true);
  });
});

describe('isFamiliarDirectionShape', () => {
  it('recognises the shapes the captured payloads actually used', () => {
    for (const { source, target } of capturedDirections()) {
      expect(isFamiliarDirectionShape(formatLanguageDirection(source, target))).toBe(true);
    }
  });

  it('flags a direction shaped unlike anything observed', () => {
    // Each of these would be a change in how the portal names a language. None is a
    // failure — but none may pass unnoticed either, because the "every arrival is one of
    // the 44" inference is exactly what a new naming scheme would break.
    // Kills: a shape check that returns true for everything, i.e. an unobservable assumption.
    expect(isFamiliarDirectionShape('en_us>th')).toBe(false); // underscore, not hyphen
    expect(isFamiliarDirectionShape('en-us>zh-hant-tw')).toBe(false); // script subtag
    expect(isFamiliarDirectionShape('en-us>')).toBe(false); // half a direction
    expect(isFamiliarDirectionShape('english>thai')).toBe(false); // display names
    expect(isFamiliarDirectionShape('en-us>th>ms-my')).toBe(false); // two separators
  });
});
