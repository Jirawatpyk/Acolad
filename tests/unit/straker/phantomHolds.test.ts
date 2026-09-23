import { describe, expect, it } from 'vitest';
import { phantomHolds } from '../../../src/straker/phantomHolds.js';

/**
 * The cleanup releases held work, which is how the ceiling is handed back — so the only part
 * worth pinning down is which rows it decides are duplicates. Two honest shapes wear the same
 * languageless key and must survive it: a real DTP job, and a real monolingual translation
 * claim of a reference whose other jobs are bilingual. `reconcile.ts` protects the second one
 * explicitly; a cleanup that released it would undo that.
 */
const HELD_SINCE = Date.parse('2026-09-23T11:01:23+07:00');

interface Row {
  objId: string;
  identity: { jobRef: string | null; service: string | null; workKey: string | null };
  heldSinceMs: number;
}

function row(
  objId: string,
  jobRef: string | null,
  service: string | null,
  workKey: string | null,
  heldSinceMs = HELD_SINCE,
): Row {
  return { objId, identity: { jobRef, service, workKey }, heldSinceMs };
}

/** Everything reconciliation created. Anything not in here the bot won for itself. */
const recovered = (...ids: string[]): ReadonlySet<string> => new Set(ids);

describe('phantomHolds', () => {
  it('finds the languageless duplicates a per-hour job left behind', () => {
    // The live shape: seven claims keyed by language, six purchase orders keyed by neither.
    const claims = ['th', 'ar', 'ko', 'zh-cn', 'id', 'zh-tw', 'ms-my'].map((lang) =>
      row(`offer-${lang}`, 'aj-345', 'translation', `aj-345|${lang}|translation`),
    );
    const orderIds = ['po-a', 'po-b', 'po-c', 'po-d', 'po-e', 'po-f'];
    const orders = orderIds.map((id) => row(id, 'aj-345', 'translation', 'aj-345||translation'));

    const found = phantomHolds([...claims, ...orders], recovered(...orderIds));

    expect(found.phantoms.map((p) => p.objId)).toEqual(orderIds);
    expect(found.unexplained).toEqual([]);
    // Every one names the keyed holds that prove it is a duplicate.
    expect(found.phantoms[0]?.siblings).toEqual(claims.map((c) => c.objId));
  });

  it('spares a real monolingual claim, which wears the same key honestly', () => {
    // THE case the first cut got wrong. A monolingual job of a reference whose siblings are
    // bilingual is legitimately keyed `ref||service` — and `reconcile.ts` settles its unknown
    // claim ahead of the bucket precisely so it keeps its own hold. Releasing it here would
    // hand back the ceiling for work the team owes. It is spared by where it came from: the
    // bot won it, so it has no recovery event.
    const held = [
      row('offer-th', 'aj-345', 'translation', 'aj-345|th|translation'),
      row('offer-mono', 'aj-345', 'translation', 'aj-345||translation'),
    ];

    expect(phantomHolds(held, recovered())).toEqual({ phantoms: [], unexplained: [] });
  });

  it('tells a recovery from a claim in the same bucket', () => {
    const held = [
      row('offer-th', 'aj-345', 'translation', 'aj-345|th|translation'),
      row('offer-ko', 'aj-345', 'translation', 'aj-345|ko|translation'),
      row('offer-mono', 'aj-345', 'translation', 'aj-345||translation'),
      row('po-dup', 'aj-345', 'translation', 'aj-345||translation'),
    ];

    const found = phantomHolds(held, recovered('po-dup'));

    expect(found.phantoms.map((p) => p.objId)).toEqual(['po-dup']);
    expect(found.unexplained).toEqual([]);
  });

  it('leaves a real DTP job alone, whose key names no language honestly', () => {
    // No sibling keyed by language, because the job has no target — nothing to duplicate.
    // Spared even though reconciliation did recover one of the rows.
    const held = [
      row('offer-dtp', 'aj-295', 'dtp_prep', 'aj-295||dtp_prep'),
      row('po-dtp', 'aj-295', 'dtp_prep', 'aj-295||dtp_prep'),
    ];

    expect(phantomHolds(held, recovered('po-dtp'))).toEqual({ phantoms: [], unexplained: [] });
  });

  it('keeps the two apart when both are held at once', () => {
    const held = [
      row('offer-th', 'aj-345', 'translation', 'aj-345|th|translation'),
      row('po-dup', 'aj-345', 'translation', 'aj-345||translation'),
      row('offer-dtp', 'aj-295', 'dtp_prep', 'aj-295||dtp_prep'),
    ];

    expect(
      phantomHolds(held, recovered('po-dup', 'offer-dtp')).phantoms.map((p) => p.objId),
    ).toEqual(['po-dup']);
  });

  it('releases no more per reference than its keyed holds can explain', () => {
    // One keyed sibling cannot be duplicated three times. The two it cannot account for are
    // reported rather than released — at least one of them is work nobody recorded twice.
    const held = [
      row('offer-th', 'aj-345', 'translation', 'aj-345|th|translation'),
      row('po-1', 'aj-345', 'translation', 'aj-345||translation', HELD_SINCE + 1),
      row('po-2', 'aj-345', 'translation', 'aj-345||translation', HELD_SINCE + 2),
      row('po-3', 'aj-345', 'translation', 'aj-345||translation', HELD_SINCE + 3),
    ];

    const found = phantomHolds(held, recovered('po-1', 'po-2', 'po-3'));

    // Oldest first — the order `heldWork()` already returns.
    expect(found.phantoms.map((p) => p.objId)).toEqual(['po-1']);
    expect(found.unexplained).toEqual(['po-2', 'po-3']);
  });

  it('does not reach across a different reference or a different service', () => {
    const held = [
      row('offer-th', 'aj-345', 'translation', 'aj-345|th|translation'),
      // Same reference, different service — a DTP stage of the same job is its own work.
      row('po-dtp', 'aj-345', 'dtp_prep', 'aj-345||dtp_prep'),
      // Same service, different reference.
      row('po-other', 'aj-999', 'translation', 'aj-999||translation'),
    ];

    expect(phantomHolds(held, recovered('po-dtp', 'po-other'))).toEqual({
      phantoms: [],
      unexplained: [],
    });
  });

  it('matches the way the key matches, not the way the payload spells it', () => {
    // `jobRef`/`service` are stored as the portal wrote them; the key is folded. Comparing
    // the raw fields would miss exactly the rows this is meant to find.
    const held = [
      row('offer-th', ' AJ-345 ', 'Translation', 'aj-345|th|translation'),
      row('po-dup', 'aj-345', 'translation', 'aj-345||translation'),
    ];

    expect(phantomHolds(held, recovered('po-dup')).phantoms.map((p) => p.objId)).toEqual([
      'po-dup',
    ]);
  });

  it('ignores a hold with no key at all', () => {
    // A keyless win has its own mechanism (`transferKeyless`) and no bucket to belong to.
    const held: { objId: string; heldSinceMs: number }[] = [
      { objId: 'offer-keyless', heldSinceMs: HELD_SINCE },
    ];

    expect(
      phantomHolds(
        [row('offer-th', 'aj-345', 'translation', 'aj-345|th|translation'), ...held],
        recovered('offer-keyless'),
      ),
    ).toEqual({ phantoms: [], unexplained: [] });
  });
});
