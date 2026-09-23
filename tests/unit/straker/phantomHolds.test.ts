import { describe, expect, it } from 'vitest';
import { phantomHolds } from '../../../src/straker/phantomHolds.js';

/**
 * The cleanup releases held work, which is how the ceiling is handed back — so the only part
 * worth pinning down is which rows it decides are duplicates. A real DTP job's key names no
 * language either, legitimately, and releasing one would hand back a ceiling the team still
 * owes work against.
 */
const HELD_SINCE = Date.parse('2026-09-23T11:01:23+07:00');

function row(
  objId: string,
  jobRef: string | null,
  service: string | null,
  workKey: string | null,
): {
  objId: string;
  identity: { jobRef: string | null; service: string | null; workKey: string | null };
  heldSinceMs: number;
} {
  return { objId, identity: { jobRef, service, workKey }, heldSinceMs: HELD_SINCE };
}

describe('phantomHolds', () => {
  it('finds the languageless duplicates a per-hour job left behind', () => {
    // The live shape: seven claims keyed by language, six purchase orders keyed by neither.
    const claims = ['th', 'ar', 'ko', 'zh-cn', 'id', 'zh-tw', 'ms-my'].map((lang) =>
      row(`offer-${lang}`, 'aj-345', 'translation', `aj-345|${lang}|translation`),
    );
    const orders = ['po-a', 'po-b', 'po-c', 'po-d', 'po-e', 'po-f'].map((id) =>
      row(id, 'aj-345', 'translation', 'aj-345||translation'),
    );

    const found = phantomHolds([...claims, ...orders]);

    expect(found.map((p) => p.objId)).toEqual(['po-a', 'po-b', 'po-c', 'po-d', 'po-e', 'po-f']);
    // Every one names the keyed holds that prove it is a duplicate.
    expect(found[0]?.siblings).toEqual(claims.map((c) => c.objId));
  });

  it('leaves a real DTP job alone, whose key names no language honestly', () => {
    // No sibling keyed by language, because the job has no target — nothing to duplicate.
    const held = [
      row('offer-dtp', 'aj-295', 'dtp_prep', 'aj-295||dtp_prep'),
      row('po-dtp', 'aj-295', 'dtp_prep', 'aj-295||dtp_prep'),
    ];

    expect(phantomHolds(held)).toEqual([]);
  });

  it('keeps the two apart when both are held at once', () => {
    const held = [
      row('offer-th', 'aj-345', 'translation', 'aj-345|th|translation'),
      row('po-dup', 'aj-345', 'translation', 'aj-345||translation'),
      row('offer-dtp', 'aj-295', 'dtp_prep', 'aj-295||dtp_prep'),
    ];

    expect(phantomHolds(held).map((p) => p.objId)).toEqual(['po-dup']);
  });

  it('does not reach across a different reference or a different service', () => {
    const held = [
      row('offer-th', 'aj-345', 'translation', 'aj-345|th|translation'),
      // Same reference, different service — a DTP stage of the same job is its own work.
      row('po-dtp', 'aj-345', 'dtp_prep', 'aj-345||dtp_prep'),
      // Same service, different reference.
      row('po-other', 'aj-999', 'translation', 'aj-999||translation'),
    ];

    expect(phantomHolds(held)).toEqual([]);
  });

  it('matches the way the key matches, not the way the payload spells it', () => {
    // `jobRef`/`service` are stored as the portal wrote them; the key is folded. Comparing
    // the raw fields would miss exactly the rows this is meant to find.
    const held = [
      row('offer-th', ' AJ-345 ', 'Translation', 'aj-345|th|translation'),
      row('po-dup', 'aj-345', 'translation', 'aj-345||translation'),
    ];

    expect(phantomHolds(held).map((p) => p.objId)).toEqual(['po-dup']);
  });

  it('ignores a hold with no key at all', () => {
    // A keyless win has its own mechanism (`transferKeyless`) and no bucket to belong to.
    const held = [
      row('offer-th', 'aj-345', 'translation', 'aj-345|th|translation'),
      { objId: 'offer-keyless', heldSinceMs: HELD_SINCE },
    ];

    expect(phantomHolds(held)).toEqual([]);
  });
});
