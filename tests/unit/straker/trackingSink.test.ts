import { describe, expect, it } from 'vitest';
import type { StrakerSender } from '../../../src/straker/dispatcher.js';
import {
  createTrackingSink,
  TRACKING_HEADER,
  type TrackingRecord,
  type TrackingSheetApi,
} from '../../../src/straker/trackingSink.js';

/**
 * The tracking record — Straker's own file (T045/T046, FR-014, FR-011a, V10).
 *
 * Two things are being pinned here, and they are the two the contract singles out.
 *
 * **Every offer seen produces a row.** Not only the won ones. Without the losses and the
 * skips the team cannot tell "Straker sends us nothing" from "we keep arriving second", and
 * the win rate has no denominator — so a sink that quietly writes only wins would look
 * perfectly healthy while destroying the only number this feature exists to produce. Rows
 * are deduplicated on **identity together with event type**: one offer legitimately
 * produces a sighting, a claim and possibly a recovery, and identity alone collapses three
 * real events into one row.
 *
 * **A shifted layout fails loud.** The XTM bot needed that guard after a real incident.
 * Writing a deadline into the effort column silently is worse than not writing at all,
 * because the wrong number is indistinguishable from a right one once it is in the sheet.
 *
 * Nothing here touches the network. The sink takes an injected sheet, exactly as the XTM
 * one does, so `google-credentials.json` — a real, gitignored credential — is never opened
 * by a test and no request ever leaves the machine.
 */

/**
 * The layout, spelled out rather than imported.
 *
 * Deriving it from `TRACKING_HEADER` would make this assertion follow the implementation
 * wherever it went, which is the one thing a layout test must not do: the whole point of
 * T046 is that a column moving is an event, not a detail. Changing this array is how a
 * future layout change announces itself.
 */
const EXPECTED_HEADER = [
  'First seen', // A
  'Event', // B
  'Outcome', // C
  'Offer ID', // D
  'Language direction', // E
  'Deadline', // F
  'Words', // G
  'Skip reason', // H
  'Claimed at', // I
  'Note', // J
  '_row_key', // K
  // Version 2 (2026-09-22): appended to the right of the key, so no existing row moves.
  'File name', // L
  'Job ref', // M
  'Service', // N
];

/** Version 1 — the layout a sheet written before 2026-09-22 carries. */
const V1_HEADER = EXPECTED_HEADER.slice(0, 11);

/** Column K — the hidden upsert key. Hardcoded for the same reason as the header above. */
const ROW_KEY_COLUMN = 10;

const FIRST_SEEN = Date.parse('2026-09-15T13:56:20+07:00');
const CLAIMED_AT = Date.parse('2026-09-15T13:56:22+07:00');
const DEADLINE = Date.parse('2026-09-16T11:00:00+07:00');

/** An offer from the captured sample (`fixtures/straker/offers/`), reduced to a record. */
const WON: TrackingRecord = {
  eventType: 'claim',
  objId: '66ae223e-8828-45f7-91c8-e6a841cc346e',
  languageDirection: 'en-us>ms-my',
  effortWords: 2,
  deadlineMs: DEADLINE,
  firstSeenAtMs: FIRST_SEEN,
  claimedAtMs: CLAIMED_AT,
  outcome: 'won',
  note: null,
};

interface FakeSheet {
  readonly api: TrackingSheetApi;
  /** Every mutating call, in order — so "wrote nothing" is a fact rather than an absence. */
  readonly writes: readonly { op: 'header' | 'append' | 'write'; rowNum: number | null }[];
  readonly rows: readonly (readonly string[])[];
  header(): readonly string[];
  /** Someone edits the sheet by hand. The guard must notice on the very next write. */
  reshapeTo(header: readonly string[]): void;
}

function fakeSheet(
  options: {
    header?: readonly string[];
    failWrites?: string;
    /**
     * Runs after each key-column scan, with the live rows — a human (or the other bot's
     * writer) editing the sheet between our scan and our write.
     */
    afterKeyScan?: (rows: string[][], scan: number) => void;
  } = {},
): FakeSheet {
  let header: string[] = [...(options.header ?? [])];
  const rows: string[][] = [];
  const writes: { op: 'header' | 'append' | 'write'; rowNum: number | null }[] = [];
  let scans = 0;
  const refuse = (): never => {
    throw new Error(options.failWrites ?? 'unreachable');
  };

  return {
    api: {
      getHeader: async () => [...header],
      setHeader: async (values) => {
        header = [...values];
        writes.push({ op: 'header', rowNum: null });
      },
      // Index 0 is the header cell, as the live Sheets range returns it.
      getKeyColumn: async () => {
        const column = [
          header[ROW_KEY_COLUMN] ?? '',
          ...rows.map((row) => row[ROW_KEY_COLUMN] ?? ''),
        ];
        options.afterKeyScan?.(rows, scans++);
        return column;
      },
      // Sheet row 1 is the header; data row n lives at rows[n - 2].
      getKeyAt: async (rowNum) =>
        rowNum === 1 ? (header[ROW_KEY_COLUMN] ?? '') : (rows[rowNum - 2]?.[ROW_KEY_COLUMN] ?? ''),
      appendRow: async (values) => {
        if (options.failWrites !== undefined) refuse();
        rows.push([...values]);
        writes.push({ op: 'append', rowNum: null });
      },
      writeRow: async (rowNum, values) => {
        if (options.failWrites !== undefined) refuse();
        rows[rowNum - 2] = [...values]; // sheet row 1 is the header
        writes.push({ op: 'write', rowNum });
      },
    },
    writes,
    rows,
    header: () => header,
    reshapeTo: (next) => {
      header = [...next];
    },
  };
}

/** A headed sheet, so a test about rows is not also a test about the header. */
function headedSheet(): FakeSheet {
  return fakeSheet({ header: EXPECTED_HEADER });
}

/**
 * What the dispatcher actually hands a sender: the payload after a JSON round trip through
 * the outbox. Passing the object straight in would let a record survive that only survives
 * because it never left the process.
 */
function viaQueue(record: TrackingRecord): unknown {
  return JSON.parse(JSON.stringify(record)) as unknown;
}

describe('the tracking sink plugs into the dispatcher as its tracking sender', () => {
  it('is a StrakerSender — the dispatcher owns the row, the retry and the logging', () => {
    // Assignability is the assertion; `npm run typecheck` is what enforces it. A sink with
    // its own retry loop or its own row-reading would not fit this type.
    const sink: StrakerSender = createTrackingSink(headedSheet().api);
    expect(typeof sink).toBe('function');
  });
});

describe('every offer seen produces a row — won, lost and skipped alike (FR-014, V10)', () => {
  it('writes the layout when the sheet is empty, then the row', async () => {
    const sheet = fakeSheet();

    const result = await createTrackingSink(sheet.api)(viaQueue(WON));

    expect(result).toEqual({ ok: true });
    expect(sheet.header()).toEqual(EXPECTED_HEADER);
    expect(sheet.rows).toHaveLength(1);
  });

  it('carries identity, language direction, effort, deadline, outcome and both timestamps', async () => {
    const sheet = headedSheet();

    await createTrackingSink(sheet.api)(viaQueue(WON));

    // The whole row, cell by cell. A per-field assertion passes just as happily when two
    // adjacent columns have swapped places, which is the failure T046 exists to prevent.
    expect(sheet.rows[0]).toEqual([
      '15/09/2026 13:56:20',
      'Claim',
      'Won',
      '66ae223e-8828-45f7-91c8-e6a841cc346e',
      'en-us>ms-my',
      '16/09/2026 11:00',
      '2',
      '',
      '15/09/2026 13:56:22',
      '',
      '66ae223e-8828-45f7-91c8-e6a841cc346e|claim',
      '', // L — File name (version 2): WON carries none
      '', // M — Job ref
      '', // N — Service
    ]);
  });

  it('writes a lost race exactly as it writes a win — it is the win rate’s denominator', async () => {
    const sheet = headedSheet();

    const result = await createTrackingSink(sheet.api)(
      viaQueue({ ...WON, outcome: 'lost', note: 'another vendor claimed it first' }),
    );

    expect(result).toEqual({ ok: true });
    expect(sheet.rows[0]?.[2]).toBe('Lost');
    expect(sheet.rows[0]?.[9]).toBe('another vendor claimed it first');
  });

  it('writes a sighting, before there is any outcome to report', async () => {
    const sheet = headedSheet();

    await createTrackingSink(sheet.api)(
      viaQueue({
        eventType: 'sighting',
        objId: 'aj-267',
        languageDirection: 'en-us>zh-tw',
        effortWords: 4,
        deadlineMs: DEADLINE,
        firstSeenAtMs: FIRST_SEEN,
        note: null,
      }),
    );

    expect(sheet.rows[0]?.[1]).toBe('Sighting');
    expect(sheet.rows[0]?.[2]).toBe(''); // no outcome yet, and none invented
    expect(sheet.rows[0]?.[8]).toBe(''); // not claimed
  });

  it('writes a skip with its reason in plain language, not as a code', async () => {
    const sheet = headedSheet();

    await createTrackingSink(sheet.api)(
      viaQueue({
        eventType: 'skip',
        objId: 'aj-265',
        languageDirection: 'en-us>th',
        effortWords: 2,
        deadlineMs: DEADLINE,
        firstSeenAtMs: FIRST_SEEN,
        skipReason: 'deadline_unreachable',
        note: '2 words cannot be finished in working time before 16/09/2026 11:00',
      }),
    );

    const row = sheet.rows[0];
    expect(row?.[1]).toBe('Skip');
    expect(row?.[2]).toBe(''); // a skip has no claim outcome
    // Plain language (contract §1): a reader must not need the source to know what happened.
    expect(row?.[7]).toBe('not enough working time before the deadline');
    expect(row?.[7]).not.toContain('_');
  });

  it('leaves an unknown effort or deadline empty rather than inventing one', async () => {
    const sheet = headedSheet();

    await createTrackingSink(sheet.api)(
      viaQueue({
        eventType: 'skip',
        objId: 'aj-268',
        languageDirection: 'en-us>th',
        effortWords: null,
        deadlineMs: null,
        firstSeenAtMs: FIRST_SEEN,
        skipReason: 'effort_unknown',
        note: null,
      }),
    );

    expect(sheet.rows[0]?.[5]).toBe(''); // deadline
    expect(sheet.rows[0]?.[6]).toBe(''); // words — never a 0 that reads as "free"
  });

  it('records work recovered by reconciliation, including work never sighted', async () => {
    const sheet = headedSheet();

    const result = await createTrackingSink(sheet.api)(
      viaQueue({
        eventType: 'recovery',
        objId: 'aj-269',
        languageDirection: 'en-us>ms-my',
        effortWords: 120,
        deadlineMs: DEADLINE,
        firstSeenAtMs: null, // reconciliation found work no sighting ever recorded
        claimedAtMs: CLAIMED_AT,
        outcome: 'recovered',
        note: 'found by reconciliation',
      }),
    );

    expect(result).toEqual({ ok: true });
    expect(sheet.rows[0]?.[0]).toBe(''); // no first sighting to claim there was one
    expect(sheet.rows[0]?.[2]).toBe('Recovered');
  });
});

describe('rows are keyed on identity together with event type (FR-014, constitution VII)', () => {
  it('turns a sighting, a claim and a recovery of ONE offer into three rows, not one', async () => {
    const sheet = headedSheet();
    const sink = createTrackingSink(sheet.api);
    const objId = WON.objId;

    await sink(
      viaQueue({
        eventType: 'sighting',
        objId,
        languageDirection: 'en-us>ms-my',
        effortWords: 2,
        deadlineMs: DEADLINE,
        firstSeenAtMs: FIRST_SEEN,
        note: null,
      }),
    );
    await sink(viaQueue({ ...WON, outcome: 'unknown' }));
    await sink(
      viaQueue({
        eventType: 'recovery',
        objId,
        languageDirection: 'en-us>ms-my',
        effortWords: 2,
        deadlineMs: DEADLINE,
        firstSeenAtMs: FIRST_SEEN,
        claimedAtMs: CLAIMED_AT,
        outcome: 'recovered',
        note: null,
      }),
    );

    // Three real events. Keyed on identity alone they would be one row, and the record
    // would say the offer was recovered without ever saying its claim came back unknown.
    expect(sheet.rows).toHaveLength(3);
    expect(sheet.rows.map((row) => row[ROW_KEY_COLUMN])).toEqual([
      `${objId}|sighting`,
      `${objId}|claim`,
      `${objId}|recovery`,
    ]);
    expect(sheet.rows.map((row) => row[2])).toEqual(['', 'Unknown', 'Recovered']);
  });

  it('updates a row in place when the same event is sent again, rather than duplicating it', async () => {
    const sheet = headedSheet();
    const sink = createTrackingSink(sheet.api);

    await sink(viaQueue({ ...WON, outcome: 'unknown', note: 'no confirmation' }));
    await sink(viaQueue({ ...WON, outcome: 'won', note: 'settled by reconciliation' }));

    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0]?.[2]).toBe('Won');
    expect(sheet.writes.map((w) => w.op)).toEqual(['append', 'write']);
    // Row 2 of the sheet: row 1 is the header. Off by one here overwrites the header.
    expect(sheet.writes[1]?.rowNum).toBe(2);
  });

  it('keeps two different offers apart even when their event type is the same', async () => {
    const sheet = headedSheet();
    const sink = createTrackingSink(sheet.api);

    await sink(viaQueue(WON));
    await sink(viaQueue({ ...WON, objId: '2a956065-dffa-420a-8893-6cd54bcce3d6' }));

    expect(sheet.rows).toHaveLength(2);
  });
});

describe('the upsert re-reads the key before overwriting a row (2026-09-22)', () => {
  // Sheets has no compare-and-set. Between scanning the key column and writing row n, a
  // human can insert or sort rows — and the write then lands on SOMEBODY ELSE'S row. The
  // re-read narrows that window to the gap between two requests; it cannot close it.
  const OTHER = { ...WON, objId: '2a956065-dffa-420a-8893-6cd54bcce3d6' };

  it('re-scans and writes the row where the key now is when a row moved in between', async () => {
    let moved = false;
    const sheet = fakeSheet({
      header: EXPECTED_HEADER,
      afterKeyScan: (rows, scan) => {
        // On the update's first scan only: someone inserts a blank row at the top.
        if (scan === 2 && !moved) {
          moved = true;
          rows.unshift(new Array<string>(EXPECTED_HEADER.length).fill(''));
        }
      },
    });
    const sink = createTrackingSink(sheet.api);
    await sink(viaQueue(WON)); // scan 0 → append, row 2
    await sink(viaQueue(OTHER)); // scan 1 → append, row 3

    const result = await sink(viaQueue({ ...WON, outcome: 'lost' })); // scan 2 moves, scan 3 finds

    expect(result).toEqual({ ok: true });
    // WON's row is now sheet row 3; the blank row and OTHER's row are untouched.
    expect(sheet.writes.at(-1)).toEqual({ op: 'write', rowNum: 3 });
    expect(sheet.rows[0]?.every((cell) => cell === '')).toBe(true);
    expect(sheet.rows[1]?.[2]).toBe('Lost');
    expect(sheet.rows[2]?.[ROW_KEY_COLUMN]).toBe(`${OTHER.objId}|claim`);
    expect(sheet.rows[2]?.[2]).toBe('Won');
  });

  it('refuses to write — and lets the outbox retry — when the key keeps moving', async () => {
    const sheet = fakeSheet({
      header: EXPECTED_HEADER,
      afterKeyScan: (rows, scan) => {
        if (scan >= 1) rows.unshift(new Array<string>(EXPECTED_HEADER.length).fill(''));
      },
    });
    const sink = createTrackingSink(sheet.api);
    await sink(viaQueue(WON));
    const writesBefore = sheet.writes.length;

    const result = await sink(viaQueue({ ...WON, outcome: 'lost' }));

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/moved/);
    expect(sheet.writes.length).toBe(writesBefore); // nothing overwritten
    expect(sheet.rows.some((row) => row[2] === 'Lost')).toBe(false);
  });

  it('appends when the re-scan finds the row gone', async () => {
    const sheet = fakeSheet({
      header: EXPECTED_HEADER,
      afterKeyScan: (rows, scan) => {
        if (scan === 1) rows.splice(0, 1); // someone deleted it after our scan
      },
    });
    const sink = createTrackingSink(sheet.api);
    await sink(viaQueue(WON));

    const result = await sink(viaQueue({ ...WON, outcome: 'lost' }));

    expect(result).toEqual({ ok: true });
    expect(sheet.writes.at(-1)).toEqual({ op: 'append', rowNum: null });
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0]?.[2]).toBe('Lost');
  });
});

describe('a shifted layout fails loud rather than writing into the wrong columns (T046)', () => {
  it('refuses to write when a column has been inserted, and writes NOTHING', async () => {
    // Somebody added a column before Words. Every cell from G rightwards now means
    // something else: the deadline would land in the effort column, and nothing about the
    // resulting row would look wrong.
    const shifted = [...EXPECTED_HEADER];
    shifted.splice(6, 0, 'Budget');
    const sheet = fakeSheet({ header: shifted });

    const result = await createTrackingSink(sheet.api)(viaQueue(WON));

    expect(result.ok).toBe(false);
    expect(sheet.writes).toEqual([]); // not the header, not the row — nothing
    expect(sheet.rows).toEqual([]);
  });

  it('says where the layout departed, so an operator can see the shift', async () => {
    const shifted = [...EXPECTED_HEADER];
    shifted.splice(6, 0, 'Budget');

    const result = await createTrackingSink(fakeSheet({ header: shifted }).api)(viaQueue(WON));

    expect(result).toMatchObject({ ok: false });
    const reason = result.ok ? '' : result.reason;
    expect(reason).toContain('G'); // the column that moved
    expect(reason).toContain('Words'); // what belongs there
    expect(reason).toContain('Budget'); // what was found instead
  });

  it('refuses a truncated layout too — a missing column shifts everything after it', async () => {
    const sheet = fakeSheet({ header: EXPECTED_HEADER.slice(0, 9) });

    const result = await createTrackingSink(sheet.api)(viaQueue(WON));

    expect(result.ok).toBe(false);
    expect(sheet.writes).toEqual([]);
  });

  it('does NOT refuse extra columns a human added to the right of the layout', async () => {
    // The XTM bot's lesson: an over-strict check turns a harmless notes column into a
    // dead-lettered outcome and a page at 03:00. Nothing inside the layout has moved.
    const sheet = fakeSheet({ header: [...EXPECTED_HEADER, 'Invoice', 'Paid?'] });

    const result = await createTrackingSink(sheet.api)(viaQueue(WON));

    expect(result).toEqual({ ok: true });
    expect(sheet.rows).toHaveLength(1);
  });

  it('checks the layout before EVERY write, not once per process', async () => {
    // A sheet is a live document. Caching the check after one success means a column
    // inserted at 10am is written across for the rest of the day.
    const sheet = headedSheet();
    const sink = createTrackingSink(sheet.api);
    expect(await sink(viaQueue(WON))).toEqual({ ok: true });

    const shifted = [...EXPECTED_HEADER];
    shifted.splice(6, 0, 'Budget');
    sheet.reshapeTo(shifted);

    const second = await sink(viaQueue({ ...WON, objId: 'aj-270' }));

    expect(second.ok).toBe(false);
    expect(sheet.rows).toHaveLength(1); // the first row, and only it
  });

  it('never overwrites an unrecognised sheet with its own header', async () => {
    const sheet = fakeSheet({ header: ['Date', 'Job', 'Notes'] });

    await createTrackingSink(sheet.api)(viaQueue(WON));

    expect(sheet.header()).toEqual(['Date', 'Job', 'Notes']);
  });
});

describe('failures are reported to the dispatcher, never thrown and never retried here', () => {
  it('reports a transport failure once — the outbox owns the retry', async () => {
    const sheet = fakeSheet({ header: EXPECTED_HEADER, failWrites: 'Sheets API unavailable' });
    let calls = 0;
    const counting: TrackingSheetApi = {
      ...sheet.api,
      appendRow: async (values) => {
        calls++;
        await sheet.api.appendRow(values);
      },
    };

    const result = await createTrackingSink(counting)(viaQueue(WON));

    expect(result).toEqual({ ok: false, reason: 'Sheets API unavailable' });
    expect(calls).toBe(1); // a retry loop in here would double-write on a partial success
  });

  it('reports a payload that is not a tracking record, and writes nothing', async () => {
    const sheet = headedSheet();

    const result = await createTrackingSink(sheet.api)({ objId: 'aj-271', outcome: 'won' });

    expect(result.ok).toBe(false);
    expect(sheet.writes).toEqual([]);
  });

  it('refuses a claim with no outcome rather than writing a blank one', async () => {
    const sheet = headedSheet();
    const { outcome: _dropped, ...withoutOutcome } = WON;

    const result = await createTrackingSink(sheet.api)(withoutOutcome);

    expect(result.ok).toBe(false);
    expect(sheet.rows).toEqual([]);
  });

  it('ignores an outcome smuggled onto a skip instead of writing it', async () => {
    // The union stops this at compile time inside the process; across the queue it is
    // JSON, and the only thing between it and the Outcome column is the parse.
    const sheet = headedSheet();

    await createTrackingSink(sheet.api)({
      eventType: 'skip',
      objId: 'aj-272',
      languageDirection: 'en-us>th',
      effortWords: 2,
      deadlineMs: DEADLINE,
      firstSeenAtMs: FIRST_SEEN,
      skipReason: 'ceiling_reached',
      outcome: 'won',
      note: null,
    });

    expect(sheet.rows[0]?.[2]).toBe('');
  });
});

describe('the sheet reads like a record a person keeps, not a log a machine writes', () => {
  it('renders the two race timestamps to the second, in the readable Bangkok format', async () => {
    // Seconds are not decoration here. First seen and Claimed at are the two ends of
    // SC-001's latency measure, and the races observed so far are decided inside two
    // seconds — a minute-resolution format would quantise the whole measurement away.
    const sheet = headedSheet();

    await createTrackingSink(sheet.api)(viaQueue(WON));

    expect(sheet.rows[0]?.[0]).toBe('15/09/2026 13:56:20');
    expect(sheet.rows[0]?.[8]).toBe('15/09/2026 13:56:22');
  });

  it('renders the deadline to the minute — a deadline has no second hand', async () => {
    const sheet = headedSheet();

    await createTrackingSink(sheet.api)(viaQueue(WON));

    expect(sheet.rows[0]?.[5]).toBe('16/09/2026 11:00');
  });

  it('keeps a deadline on the far side of midnight Bangkok on its Bangkok date', async () => {
    // 23:30 UTC is 06:30 the NEXT day in Bangkok. A formatter that shifted the clock but
    // read the date off the unshifted value would print the day before, and the operator
    // would read a deadline that has already passed.
    const sheet = headedSheet();

    await createTrackingSink(sheet.api)(
      viaQueue({ ...WON, deadlineMs: Date.parse('2026-09-16T23:30:00Z') }),
    );

    expect(sheet.rows[0]?.[5]).toBe('17/09/2026 06:30');
  });

  it('leaves an absent timestamp blank rather than printing an epoch', async () => {
    // Reconciliation finds work no sighting ever recorded (FR-016a). "never sighted" has
    // to read as empty; 01/01/1970 would read as a real, very old sighting.
    const sheet = headedSheet();

    await createTrackingSink(sheet.api)(
      viaQueue({
        eventType: 'recovery',
        objId: 'aj-900',
        languageDirection: 'en-us>ms-my',
        effortWords: 3,
        deadlineMs: null,
        firstSeenAtMs: null,
        claimedAtMs: CLAIMED_AT,
        outcome: 'recovered',
        note: 'found held on the portal with no sighting on record',
      }),
    );

    expect(sheet.rows[0]?.[0]).toBe('');
    expect(sheet.rows[0]?.[5]).toBe('');
  });

  it('capitalises Event and Outcome without touching the hidden key they are built from', async () => {
    // The cells are for a reader; `_row_key` is the upsert's identity. If capitalising the
    // display had leaked into the key, every existing row would stop matching and the sink
    // would append a duplicate instead of updating in place.
    const sheet = headedSheet();

    await createTrackingSink(sheet.api)(viaQueue(WON));
    await createTrackingSink(sheet.api)(viaQueue({ ...WON, outcome: 'lost' }));

    expect(sheet.rows).toHaveLength(1); // the second call updated the first row
    expect(sheet.rows[0]?.[1]).toBe('Claim');
    expect(sheet.rows[0]?.[2]).toBe('Lost');
    expect(sheet.rows[0]?.[ROW_KEY_COLUMN]).toBe('66ae223e-8828-45f7-91c8-e6a841cc346e|claim');
  });
});

describe('the exported layout is the one the sink writes', () => {
  it('TRACKING_HEADER matches the layout this file pins', () => {
    // The sink and its transport both derive their ranges from this array, so publishing
    // it is what lets a caller build the sheet without re-deriving the column letters.
    expect([...TRACKING_HEADER]).toEqual(EXPECTED_HEADER);
  });
});

describe('version 2 — file name, job reference and service (2026-09-22)', () => {
  const NAMED: TrackingRecord = {
    ...WON,
    title: 'NBA - NTRY Hangtag.xlsx',
    jobRef: 'aj-310',
    service: 'translation',
  };

  it('writes the three new cells after the key, where the header names them', async () => {
    const sheet = headedSheet();

    await createTrackingSink(sheet.api)(viaQueue(NAMED));

    expect(sheet.rows[0]?.slice(11)).toEqual(['NBA - NTRY Hangtag.xlsx', 'aj-310', 'translation']);
    expect(sheet.rows[0]?.[ROW_KEY_COLUMN]).toBe(`${WON.objId}|claim`);
  });

  it('leaves them blank for a record that carries none — rows queued before the change still send', async () => {
    const sheet = headedSheet();

    expect(await createTrackingSink(sheet.api)(viaQueue(WON))).toEqual({ ok: true });
    expect(sheet.rows[0]?.slice(11)).toEqual(['', '', '']);
  });

  it('brings a version-1 sheet up to date by naming the three columns, and moves no row', async () => {
    const sheet = fakeSheet({ header: V1_HEADER });

    const result = await createTrackingSink(sheet.api)(viaQueue(NAMED));

    expect(result).toEqual({ ok: true });
    expect([...sheet.header()]).toEqual(EXPECTED_HEADER);
    expect(sheet.rows[0]?.[ROW_KEY_COLUMN]).toBe(`${WON.objId}|claim`);
  });

  it('refuses to name the columns over headings a human already put there', async () => {
    // On a version-1 sheet L–N were "a human's own". Writing over them would silently
    // relabel someone's invoice column as the file name.
    const sheet = fakeSheet({ header: [...V1_HEADER, 'Invoice'] });

    const result = await createTrackingSink(sheet.api)(viaQueue(NAMED));

    expect(result.ok).toBe(false);
    expect(sheet.header()).toEqual([...V1_HEADER, 'Invoice']);
    expect(sheet.rows).toEqual([]);
    if (!result.ok) expect(result.reason).toContain('Invoice');
  });
});
