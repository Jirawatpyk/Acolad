import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger, LogFields } from '../../../src/monitoring/logger.js';
import type { RawOffer } from '../../../src/straker/probe.js';
import {
  STRAKER_DEADLINE_ZONE,
  StrakerOfferShapeError,
  createOfferExtractor,
  parseOffer,
} from '../../../src/straker/offerParse.js';

/**
 * T033 — parsing a real offer payload (U1, FR-023, FR-023a).
 *
 * **Every expectation below is anchored on the files the capture probe wrote.** The offers
 * are read off disk and mutated from there rather than typed out here, because a parser
 * tested against hand-written literals tests the author's memory of a payload, not the
 * payload. The three committed files are the entire evidence base, and only **two of them
 * are independent** — `aj-265` arrived as one job split across `th` and `ms-my` — so the
 * suite leans on fail-loud assertions wherever the sample cannot settle a question.
 *
 * ## The boundary this file exists to pin
 *
 * | Payload condition | Result | Why |
 * |---|---|---|
 * | effort or deadline **absent** | `null` on that field — a SKIP downstream, plus FR-023a's alert | The read is fine; this one offer cannot be decided |
 * | a field of the **wrong type**, an unknown `listing_type`, a missing `obj_id` | throw | The shape changed; interpreting it is how a bot claims the wrong work while looking healthy |
 *
 * Getting that line in the wrong place is the difference between passing over one offer and
 * rejecting a whole read, so both directions are asserted, not just the loud one.
 */

const FIXTURE_DIR = join(process.cwd(), 'fixtures', 'straker', 'offers');

/** The 15 keys every captured payload carried. A 16th, or a missing one, must be seen. */
const CAPTURED_KEYS = [
  'budget',
  'currency',
  'due_at',
  'job_ref',
  'listing_type',
  'obj_id',
  'rate_type',
  'service',
  'source_lang',
  'status',
  'target_lang',
  'title',
  'total_unit',
  'unit_cost',
  'words',
];

type Payload = Record<string, unknown>;

function capturedOffers(): Payload[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as Payload);
}

/** One captured payload by its identifier, so a golden case names the offer it came from. */
function captured(objId: string): Payload {
  const found = capturedOffers().find((offer) => offer['obj_id'] === objId);
  if (!found) throw new Error(`fixture ${objId} is missing — the golden cases are anchored on it`);
  return found;
}

/** A captured payload with one field replaced or (with `undefined`) removed. */
function withField(base: Payload, field: string, value: unknown): Payload {
  const copy: Payload = { ...base };
  if (value === undefined) delete copy[field];
  else copy[field] = value;
  return copy;
}

interface Line {
  readonly level: 'info' | 'warn' | 'error';
  readonly fields: LogFields;
  readonly msg: string | undefined;
}

function recordingLogger(): Logger & { lines: Line[] } {
  const lines: Line[] = [];
  return {
    lines,
    info: (fields, msg) => lines.push({ level: 'info', fields, msg }),
    warn: (fields, msg) => lines.push({ level: 'warn', fields, msg }),
    error: (fields, msg) => lines.push({ level: 'error', fields, msg }),
  };
}

function options(overrides: Partial<Parameters<typeof parseOffer>[1]> = {}) {
  return { excludedLanguagePairs: [], logger: recordingLogger(), ...overrides };
}

// The two independent jobs, by identifier rather than by position: `readdirSync` order is
// not a contract, and the probe is still running — new files may land in this directory.
const AJ_265_MS = '66ae223e-8828-45f7-91c8-e6a841cc346e';
const AJ_265_TH = '2a956065-dffa-420a-8893-6cd54bcce3d6';
const AJ_267_ZH = '94fd32c1-d02b-4442-bc20-24c07b04fd50';

describe('the captured payloads themselves', () => {
  it('are on disk and carry the 15 keys this parser was built against', () => {
    // Guard the guard, twice over. A loader that quietly finds nothing would make every
    // golden case below vacuously true; and a NEW payload with a different key set is the
    // single most important thing this suite can tell us, because the sample is two jobs
    // deep. Either way this fails before anything downstream gets to assume a shape.
    const offers = capturedOffers();
    expect(offers.length).toBeGreaterThanOrEqual(3);
    for (const offer of offers) {
      expect(Object.keys(offer).sort()).toEqual(CAPTURED_KEYS);
    }
  });

  it('holds only one listing type across the whole sample', () => {
    // Recorded as a fact about the evidence, not as a rule: three offers of one type
    // cannot show that every type behaves this way, which is exactly why an unknown
    // `listing_type` throws below rather than being assumed claimable.
    expect([...new Set(capturedOffers().map((o) => o['listing_type']))]).toEqual(['direct_po']);
  });
});

describe('parseOffer — the golden cases, read off disk', () => {
  it('reduces the Malay half of aj-265 to the values a decision needs', () => {
    expect(parseOffer(captured(AJ_265_MS), options())).toEqual({
      objId: AJ_265_MS,
      languageDirection: 'en-us>ms-my',
      eligible: true,
      monolingual: false,
      effortWords: 2,
      // 2026-09-15T23:20:00 read as Bangkok. Asserted as an absolute instant with an
      // explicit Z, so this line stays true whatever zone the test host runs in.
      deadlineMs: Date.parse('2026-09-15T16:20:00Z'),
    });
  });

  it('reduces the Thai half of the same job independently', () => {
    // Same job_ref, same title, same due_at, same words — a different offer with its own
    // identity. Kills: deduplicating or keying on anything but `obj_id` (R8).
    expect(parseOffer(captured(AJ_265_TH), options())).toEqual({
      objId: AJ_265_TH,
      languageDirection: 'en-us>th',
      eligible: true,
      monolingual: false,
      effortWords: 2,
      deadlineMs: Date.parse('2026-09-15T16:20:00Z'),
    });
  });

  it('reduces the per-hour offer, whose effort is still the word count', () => {
    // `rate_type: per_hour`, `total_unit: 0.010` hours. Effort is FR-009's raw word count
    // regardless. Kills: reaching for `total_unit`, `budget` or `unit_cost` as effort —
    // the mis-measurement the data model calls out as looking like it is working.
    expect(parseOffer(captured(AJ_267_ZH), options())).toEqual({
      objId: AJ_267_ZH,
      languageDirection: 'en-us>zh-tw',
      eligible: true,
      monolingual: false,
      effortWords: 4,
      deadlineMs: Date.parse('2026-09-15T21:00:00Z'),
    });
  });

  it('parses every committed payload, including any the probe adds later', () => {
    // The golden cases above are pinned to three identifiers; this sweep covers whatever
    // else lands in the directory, so a fourth capture is exercised the day it arrives.
    for (const offer of capturedOffers()) {
      const parsed = parseOffer(offer, options());
      expect(parsed.objId).toBe(offer['obj_id']);
      expect(parsed.effortWords).toBeTypeOf('number');
      expect(parsed.deadlineMs).toBeTypeOf('number');
    }
  });

  it('ignores keys it does not need instead of rejecting them', () => {
    // A new field appearing is not a departure that endangers a decision — the capture
    // probe keeps the payload verbatim, and the parser reads only what it consumes.
    const parsed = parseOffer(
      withField(captured(AJ_267_ZH), 'promoted_at', '2026-09-15'),
      options(),
    );
    expect(parsed.objId).toBe(AJ_267_ZH);
  });
});

describe('parseOffer — the deadline zone, which the payload does not carry', () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it('names the assumed zone in an exported constant', () => {
    // "One line to change" is the requirement: the zone lives here, not spread across
    // `Date.parse` calls. Kills: a literal '+07:00' inlined at the parse site.
    expect(STRAKER_DEADLINE_ZONE).toEqual({ id: 'Asia/Bangkok', utcOffset: '+07:00' });
  });

  it.each(['UTC', 'America/New_York', 'Pacific/Auckland', 'Asia/Bangkok'])(
    'reads due_at as Bangkok even when the host runs in %s',
    (tz) => {
      // THE test this whole section exists for. `due_at` is zone-less
      // (`2026-09-15T23:20:00`); parsed bare it silently takes the host's zone — Bangkok
      // on the office machine, UTC in CI, NZ where the vendor is registered. On a Bangkok
      // host a bare `Date.parse` gives the right answer by accident, so the mutation
      // survives unless the host zone is moved underneath it. Node re-reads `process.env.TZ`
      // on assignment, which is what makes that possible in-process.
      // Kills: `Date.parse(raw.due_at)` and `new Date(raw.due_at)`.
      process.env.TZ = tz;
      expect(parseOffer(captured(AJ_265_MS), options()).deadlineMs).toBe(
        Date.parse('2026-09-15T16:20:00Z'),
      );
    },
  );

  it('honours an overridden zone, proving the constant is what the parse actually uses', () => {
    // If Straker turns out to mean New Zealand time (a real possibility — the vendor is a
    // New Zealand company), this is the one line that changes.
    // Kills: an implementation that reads the constant for show and hardcodes the offset.
    const nz = parseOffer(
      captured(AJ_265_MS),
      options({ deadlineZone: { id: 'Pacific/Auckland', utcOffset: '+12:00' } }),
    );
    expect(nz.deadlineMs).toBe(Date.parse('2026-09-15T11:20:00Z'));
  });

  it('works for a zone west of UTC, not just an eastern one', () => {
    // Every zone in play so far is ahead of UTC, so a dropped sign would never show. If the
    // answer to "which zone does the portal mean" ever comes back as a US one, the one-line
    // change has to work on the first try.
    // Kills: an offset parser that ignores the sign, silently landing a deadline 8h early.
    const ny = parseOffer(
      captured(AJ_265_MS),
      options({ deadlineZone: { id: 'America/New_York', utcOffset: '-04:00' } }),
    );
    expect(ny.deadlineMs).toBe(Date.parse('2026-09-16T03:20:00Z'));
  });

  it('refuses a zone whose offset it cannot read, rather than defaulting to UTC', () => {
    // A misconfigured zone silently becoming +00:00 would move every deadline by seven
    // hours while the log still announced "Asia/Bangkok" — the worst of both worlds.
    expect(() =>
      parseOffer(
        captured(AJ_265_MS),
        options({ deadlineZone: { id: 'Nowhere', utcOffset: 'BKK' } }),
      ),
    ).toThrow(/unusable UTC offset/);
  });
});

describe('parseOffer — a missing effort or deadline is a SKIP, not a failure (FR-023a)', () => {
  it('returns a null effort when the payload carries no word count', () => {
    // Kills: throwing here. A throw would reject the whole read over one offer that the
    // gate is perfectly able to refuse on its own, as `effort_unknown`.
    const parsed = parseOffer(withField(captured(AJ_265_MS), 'words', undefined), options());
    expect(parsed.effortWords).toBeNull();
    expect(parsed.objId).toBe(AJ_265_MS);
    expect(parsed.deadlineMs).toBe(Date.parse('2026-09-15T16:20:00Z'));
  });

  it('treats an explicit null word count the same way', () => {
    expect(
      parseOffer(withField(captured(AJ_265_MS), 'words', null), options()).effortWords,
    ).toBeNull();
  });

  it('treats a zero word count as no usable effort rather than as no work', () => {
    // A judgment call, recorded: zero passes every gate check trivially — the feasibility
    // sum and the daily ceiling both see nothing — so claiming on it is claiming blind.
    // The sample's real jobs were 2, 2 and 4 words; a 0 is anomalous, and `effort_unknown`
    // both refuses it and raises FR-023a's alert so a human sees it.
    expect(
      parseOffer(withField(captured(AJ_265_MS), 'words', 0), options()).effortWords,
    ).toBeNull();
  });

  it('returns a null deadline when the payload carries none', () => {
    const parsed = parseOffer(withField(captured(AJ_267_ZH), 'due_at', undefined), options());
    expect(parsed.deadlineMs).toBeNull();
    expect(parsed.effortWords).toBe(4);
  });

  it('treats an explicit null deadline the same way', () => {
    expect(
      parseOffer(withField(captured(AJ_267_ZH), 'due_at', null), options()).deadlineMs,
    ).toBeNull();
  });
});

describe('parseOffer — a wrong shape is a hard FAILURE (FR-023)', () => {
  it('rejects an entry that is not an object at all', () => {
    for (const entry of [null, 'offer', 42, []]) {
      expect(() => parseOffer(entry, options())).toThrow(StrakerOfferShapeError);
    }
  });

  it.each([
    ['obj_id', undefined],
    ['obj_id', ''],
    ['obj_id', 12345],
    ['source_lang', undefined],
    ['source_lang', ''],
    ['source_lang', ['en-us']],
    ['target_lang', undefined],
    ['target_lang', 7],
  ])('rejects %s = %o — identity and direction are not optional', (field, value) => {
    // An entry with no identity cannot be tracked or deduplicated (data model §2), and a
    // missing direction is the field that decides what language we commit to.
    expect(() => parseOffer(withField(captured(AJ_265_MS), field, value), options())).toThrow(
      StrakerOfferShapeError,
    );
  });

  it.each([
    ['a string', '2'],
    ['a negative count', -1],
    ['a fractional count', 2.5],
    ['a non-finite count', Number.NaN],
    ['an object', { value: 2 }],
  ])('rejects a word count that is %s', (_label, value) => {
    // The captured payloads carry `words` as a JSON number while the money fields are
    // strings, so a string here is a type change, not a variant. Absorbing it — parsing
    // "2" into 2 — is how a field silently becoming "2,400" ends up read as 2.
    // Kills: `Number(raw.words)`, and any `typeof === 'number'` check without the rest.
    expect(() => parseOffer(withField(captured(AJ_265_MS), 'words', value), options())).toThrow(
      StrakerOfferShapeError,
    );
  });

  it.each([
    ['a number', 1_758_000_000_000],
    ['a date without a time', '2026-09-15'],
    ['a local format', '15/09/2026 23:20'],
    ['nonsense', 'tomorrow'],
    // Two different failures wearing the same face. A 13th month makes `Date.parse` return
    // NaN; an impossible DAY does not — it silently rolls `2026-02-31` over to 3 March, a
    // deadline three days late, which is how an infeasible job passes the feasibility check.
    ['an impossible month', '2026-13-01T10:00:00'],
    ['an impossible day', '2026-02-31T10:00:00'],
  ])('rejects a deadline that is %s', (_label, value) => {
    expect(() => parseOffer(withField(captured(AJ_267_ZH), 'due_at', value), options())).toThrow(
      StrakerOfferShapeError,
    );
  });

  it('rejects a deadline that has grown its own timezone', () => {
    // The most valuable failure in this file. If Straker starts stamping a zone, our
    // Bangkok assumption is either confirmed or wrong by hours — and either way it is a
    // decision for a human, not something to absorb by letting `Date.parse` win.
    // Kills: a permissive parse that would happily accept both forms and never say so.
    for (const value of [
      '2026-09-15T23:20:00Z',
      '2026-09-15T23:20:00+13:00',
      '2026-09-15T23:20:00+07:00',
    ]) {
      expect(() => parseOffer(withField(captured(AJ_265_MS), 'due_at', value), options())).toThrow(
        StrakerOfferShapeError,
      );
    }
  });

  it.each([[undefined], [''], ['auction'], ['marketplace'], [null], [3]])(
    'rejects listing_type %o — only the observed value is known to be claimable',
    (value) => {
      // `direct_po` is all the sample has ever shown, and the spec records that what other
      // values mean is still Straker's to answer. Assuming an unknown one is claimable is
      // the irreversible direction of the mistake.
      expect(() =>
        parseOffer(withField(captured(AJ_265_MS), 'listing_type', value), options()),
      ).toThrow(StrakerOfferShapeError);
    },
  );

  it.each([[undefined], ['closed'], ['assigned'], ['OPEN'], [null]])(
    'rejects status %o — the list was asked for open offers only',
    (value) => {
      expect(() => parseOffer(withField(captured(AJ_265_MS), 'status', value), options())).toThrow(
        StrakerOfferShapeError,
      );
    },
  );

  it('names the field and the offer in the error, so the payload can be found again', () => {
    // A loud failure that does not say what broke costs an operator the evidence hunt.
    try {
      parseOffer(withField(captured(AJ_265_MS), 'words', '2'), options());
      expect.unreachable('a wrong-typed word count must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(StrakerOfferShapeError);
      const shape = error as StrakerOfferShapeError;
      expect(shape.field).toBe('words');
      expect(shape.objId).toBe(AJ_265_MS);
      expect(shape.message).toContain('words');
    }
  });
});

describe('parseOffer — a null target_lang is DTP work, not a broken payload', () => {
  /**
   * Learned from production on 2026-09-17. The portal offered `Members Co Ltd Q3.docx`
   * — 956 words, phase "DTP (prep)", Japanese to Japanese — with `target_lang: null`,
   * because preparing a document for publication has no target language to translate into.
   *
   * The parser treated that as a contract violation and threw. Seventeen consecutive cycles
   * failed, the bot saw nothing for three minutes, and the job was claimed by hand instead.
   *
   * `undefined` is deliberately NOT accepted alongside `null`. The portal was observed to
   * send an explicit null; a missing key has never been seen, and inventing a meaning for it
   * is the guessing this parser exists to refuse.
   */
  it('reads it as monolingual work rather than throwing', () => {
    const offer = parseOffer(withField(captured(AJ_265_MS), 'target_lang', null), options());

    expect(offer.monolingual).toBe(true);
  });

  it('records the direction as source-to-itself, matching what the assigned list reports', () => {
    // The same work read from the assigned-jobs endpoint comes back as `ja>ja`, because that
    // endpoint does carry a target. Rendering the two differently would put one job under two
    // names in the record — the tracking sheet and the reconciliation row would disagree.
    const offer = parseOffer(
      withField(withField(captured(AJ_265_MS), 'source_lang', 'ja'), 'target_lang', null),
      options(),
    );

    expect(offer.languageDirection).toBe('ja>ja');
  });

  it('still refuses a target_lang that is present but unusable', () => {
    // Null means "no target". An empty string or a number means the payload is wrong, and
    // that distinction is the whole reason this is not a blanket relaxation.
    for (const bad of ['', 7, []]) {
      expect(() =>
        parseOffer(withField(captured(AJ_265_MS), 'target_lang', bad), options()),
      ).toThrow(StrakerOfferShapeError);
    }
  });

  it('marks an ordinary translation offer as NOT monolingual', () => {
    // The control. Without it the flag could be hardcoded true and every test above passes.
    expect(parseOffer(captured(AJ_265_MS), options()).monolingual).toBe(false);
  });
});

describe('parseOffer — eligibility comes from the direction (FR-011)', () => {
  it('marks an excluded direction ineligible without refusing to parse it', () => {
    // An ineligible offer is still recorded — FR-017's win-rate denominator needs it.
    const parsed = parseOffer(
      captured(AJ_265_TH),
      options({ excludedLanguagePairs: ['en-us>th'] }),
    );
    expect(parsed).toMatchObject({ languageDirection: 'en-us>th', eligible: false });
  });

  it('leaves the other half of the same job eligible', () => {
    const parsed = parseOffer(
      captured(AJ_265_MS),
      options({ excludedLanguagePairs: ['en-us>th'] }),
    );
    expect(parsed.eligible).toBe(true);
  });

  it('records the direction with the portal’s own identifiers, lower-cased', () => {
    // FR-011a: the claimed language mix has to be visible in the record.
    const parsed = parseOffer(withField(captured(AJ_265_MS), 'target_lang', 'MS-MY'), options());
    expect(parsed.languageDirection).toBe('en-us>ms-my');
  });
});

describe('parseOffer — the 44-direction inference is observable, not silent', () => {
  it('warns when a direction arrives shaped unlike anything the sample showed', () => {
    // The inference: the portal only offers directions the account is registered for, so
    // every arrival is one of the 44 and eligibility is just "not excluded". Nothing in
    // this repo lists the 44, so the day that stops being true must be visible in the log.
    // Kills: an unfamiliar direction passing through unremarked.
    const logger = recordingLogger();
    const parsed = parseOffer(
      withField(captured(AJ_265_MS), 'target_lang', 'zh-Hant-TW'),
      options({ logger }),
    );

    expect(parsed.eligible).toBe(true); // reported, never refused
    const warned = logger.lines.find((l) => l.level === 'warn');
    expect(warned?.fields).toMatchObject({
      module: 'offerParse',
      outcome: 'unfamiliar_direction',
      languageDirection: 'en-us>zh-hant-tw',
      objId: AJ_265_MS,
    });
  });

  it('says nothing for the shapes the sample did show', () => {
    const logger = recordingLogger();
    for (const offer of capturedOffers()) parseOffer(offer, options({ logger }));
    expect(logger.lines.filter((l) => l.level === 'warn')).toEqual([]);
  });
});

describe('createOfferExtractor', () => {
  let logger: ReturnType<typeof recordingLogger>;
  beforeEach(() => {
    logger = recordingLogger();
  });

  it('announces the deadline-zone assumption once, at startup', () => {
    // "Visible at runtime, not only in a comment." Once per process rather than per cycle:
    // at a ten-second rhythm the latter is eight and a half thousand lines a day.
    createOfferExtractor({ excludedLanguagePairs: [], logger });

    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({
      level: 'info',
      fields: { module: 'offerParse', action: 'configure', deadlineZone: 'Asia/Bangkok' },
    });
  });

  it('maps a whole read, in order', () => {
    const extract = createOfferExtractor({ excludedLanguagePairs: [], logger });
    const raw = capturedOffers() as unknown as RawOffer[];

    expect(extract(raw).map((o) => o.objId)).toEqual(raw.map((o) => o.obj_id));
  });

  it('keeps the readable offers when one entry is malformed, and reports the bad one', () => {
    /**
     * This test asserted the OPPOSITE until 2026-09-17, and the reasoning it carried was
     * sound as far as it went: "dropping the bad entry would shrink the list silently, and a
     * shrinking list is indistinguishable from offers vanishing."
     *
     * That is true. What it missed is that those were not the only two options. On 2026-09-17
     * the portal offered a DTP job with `target_lang: null`; the throw took down the WHOLE
     * read for **17 consecutive cycles over three minutes**, during which the bot saw nothing
     * at all — and because a parse failure is not a transport failure, no alert was raised
     * either. A 956-word job was lost.
     *
     * The third option is to report the bad entry and carry on: not silent, and not fatal to
     * the offers that parsed perfectly well beside it.
     */
    const unreadable: { objId: string | null; reason: string }[] = [];
    const extract = createOfferExtractor({
      excludedLanguagePairs: [],
      logger,
      onUnreadable: (objId, reason) => unreadable.push({ objId, reason }),
    });
    const raw = [
      captured(AJ_265_MS),
      withField(captured(AJ_267_ZH), 'listing_type', 'auction'),
    ] as unknown as RawOffer[];

    const parsed = extract(raw);

    // The good offer survives — this is the whole point.
    expect(parsed.map((o) => o.objId)).toEqual([captured(AJ_265_MS).obj_id]);
    // And the bad one is named, so it can be recorded and alerted rather than vanishing.
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]?.objId).toBe(captured(AJ_267_ZH).obj_id);
    expect(unreadable[0]?.reason).toMatch(/listing_type/);
  });

  it('reports an entry so broken it has no identity, rather than throwing', () => {
    // No `obj_id` means nothing can be recorded against it, so the report carries null and
    // the caller alerts on the reason alone. Still not a reason to lose the rest of the read.
    const unreadable: { objId: string | null; reason: string }[] = [];
    const extract = createOfferExtractor({
      excludedLanguagePairs: [],
      logger,
      onUnreadable: (objId, reason) => unreadable.push({ objId, reason }),
    });

    const parsed = extract([captured(AJ_265_MS), 'not an offer at all'] as unknown as RawOffer[]);

    expect(parsed).toHaveLength(1);
    expect(unreadable[0]?.objId).toBeNull();
  });

  it('still parses everything when nothing is malformed, and reports nothing', () => {
    const unreadable: unknown[] = [];
    const extract = createOfferExtractor({
      excludedLanguagePairs: [],
      logger,
      onUnreadable: () => unreadable.push(1),
    });

    expect(extract(capturedOffers() as unknown as RawOffer[])).toHaveLength(3);
    expect(unreadable).toEqual([]);
  });

  it('returns nothing for an empty read, without inventing a failure', () => {
    const extract = createOfferExtractor({ excludedLanguagePairs: [], logger });
    expect(extract([])).toEqual([]);
  });
});
