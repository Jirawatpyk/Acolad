import { describe, expect, it } from 'vitest';
import { optionalText, workBucket, workIdentity, workKey } from '../../../src/straker/workKey.js';

/**
 * One piece of work wears three ids on this portal — the offer's, the purchase order's and
 * the assigned job's — so the only thing that ties them together is what they share: the
 * job reference, the target language and the service. Observed 2026-09-22 across 27 purchase
 * orders and 17 assigned jobs: that triple never repeated.
 */
describe('workKey', () => {
  it('ties an offer, its purchase order and its assigned job to one key', () => {
    const offer = workKey('aj-310', 'en-us', 'zh-hk', 'translation'); // offer fields
    const po = workKey('aj-310', 'en-us', 'zh-hk', 'translation'); // job_ref / *_language_code / po_type
    const assigned = workKey('aj-310', 'en-us', 'zh-hk', 'translation'); // external_job_id / *_lang / service

    expect(offer).toBe('aj-310|zh-hk|translation');
    expect(po).toBe(offer);
    expect(assigned).toBe(offer);
  });

  it('tells two languages of the same job apart', () => {
    expect(workKey('aj-310', 'en-us', 'zh-hk', 'translation')).not.toBe(
      workKey('aj-310', 'en-us', 'zh-tw', 'translation'),
    );
  });

  it('reads a DTP job the same at every stage, though each spells "no target" differently', () => {
    // The offer sends target null, the purchase order sends empty language codes, the
    // assigned job repeats the source (`ja>ja`). All three are the same job.
    const offer = workKey('aj-295', 'ja', null, 'dtp_prep');
    expect(workKey('aj-295', '', '', 'dtp_prep')).toBe(offer);
    expect(workKey('aj-295', 'ja', 'ja', 'dtp_prep')).toBe(offer);
    expect(offer).toBe('aj-295||dtp_prep');
  });

  it('ignores case and surrounding space', () => {
    expect(workKey(' AJ-310 ', 'EN-US', ' ZH-HK', 'Translation ')).toBe('aj-310|zh-hk|translation');
  });

  it('has no key without a job reference or a service — a guess would join unrelated work', () => {
    expect(workKey(null, 'en-us', 'th', 'translation')).toBeNull();
    expect(workKey('', 'en-us', 'th', 'translation')).toBeNull();
    expect(workKey('aj-1', 'en-us', 'th', null)).toBeNull();
    expect(workKey('aj-1', 'en-us', 'th', '  ')).toBeNull();
  });
});

describe('workKey normalisation (2026-09-22)', () => {
  // Three endpoints spell one language three ways; a key that differs by a separator, a
  // zero-width character or a full-width letter is a match silently missed — and a missed
  // match is held work the restart guard cannot see and reconciliation cannot settle.
  it.each([
    ['MS_MY', 'ms-my'],
    ['ms-my​', 'ms-my'],
    [' zh-HK ', 'zh-hk'],
    ['﻿ms-MY', 'ms-my'],
    ['ｍｓ－ＭＹ', 'ms-my'], // full-width, folded by NFKC
    ['zh_Hant_TW', 'zh-hant-tw'],
  ])('reads target %j as %j', (target, expected) => {
    expect(workKey('aj-1', 'en-us', target, 'translation')).toBe(`aj-1|${expected}|translation`);
  });

  it('treats a source spelled differently as the same source (DTP target = source)', () => {
    expect(workKey('aj-295', 'JA', 'ja​', 'dtp_prep')).toBe('aj-295||dtp_prep');
    expect(workKey('aj-1', 'EN_US', 'en-us', 'translation')).toBe('aj-1||translation');
  });

  it('strips format characters and folds width in the job ref and service, keeping underscores', () => {
    expect(workKey(' AJ-310​', 'en-us', 'ms-my', 'DTP_Prep‍')).toBe('aj-310|ms-my|dtp_prep');
    expect(workKey('ＡＪ-310', 'en-us', 'ms-my', 'translation')).toBe('aj-310|ms-my|translation');
  });

  it('has no key when a field is nothing but format characters', () => {
    expect(workKey('​', 'en-us', 'ms-my', 'translation')).toBeNull();
    expect(workKey('aj-1', 'en-us', 'ms-my', '​ ')).toBeNull();
  });
});

describe('optionalText', () => {
  it('keeps a trimmed non-empty string and turns anything else into null', () => {
    expect(optionalText('  NBA - NTRY Hangtag.xlsx ')).toBe('NBA - NTRY Hangtag.xlsx');
    expect(optionalText('')).toBeNull();
    expect(optionalText(42)).toBeNull();
    expect(optionalText(undefined)).toBeNull();
  });
});

describe('workIdentity', () => {
  it('bundles the reference fields with the key they make', () => {
    expect(workIdentity('aj-310', 'en-us', 'zh-hk', 'translation', 'NBA.xlsx')).toEqual({
      jobRef: 'aj-310',
      title: 'NBA.xlsx',
      service: 'translation',
      workKey: 'aj-310|zh-hk|translation',
    });
  });

  it('keeps what it can read when a key cannot be made', () => {
    expect(workIdentity(null, 'en-us', 'th', 'translation', 'a.xlsx')).toEqual({
      jobRef: null,
      title: 'a.xlsx',
      service: 'translation',
      workKey: null,
    });
  });
});

/**
 * The weaker thing a key becomes when the portal names no language — see the file header.
 * Live 2026-09-23: six purchase orders for the per-hour job `aj-345` all keyed
 * `aj-345||translation`, matching none of the seven claims that won them.
 */
describe('workBucket', () => {
  it('is exactly the key a record with no language of its own makes', () => {
    // The identity the bucket design rests on: match on the bucket and a languageless record
    // meets its own siblings, because the two functions agree character for character.
    expect(workBucket('aj-345', 'translation')).toBe('aj-345||translation');
    expect(workKey('aj-345', '', '', 'translation')).toBe(workBucket('aj-345', 'translation'));
    // A DTP job spells it three ways across the stages; all three land on the one bucket.
    expect(workKey('aj-9', 'ja', null, 'dtp_prep')).toBe(workBucket('aj-9', 'dtp_prep'));
    expect(workKey('aj-9', 'ja', 'ja', 'dtp_prep')).toBe(workBucket('aj-9', 'dtp_prep'));
  });

  it('folds its parts the way the key folds them, not the way the payload spells them', () => {
    // `optionalText` only trims, so matching on the raw `jobRef`/`service` fields would miss
    // an offer that says `Translation` against an order that says `translation`.
    expect(workBucket('  AJ-345 ', 'Translation')).toBe(workBucket('aj-345', 'translation'));
    expect(workBucket('aj​-345', 'translation')).toBe('aj-345||translation');
  });

  it('is null when there is no honest group to name', () => {
    expect(workBucket(null, 'translation')).toBeNull();
    expect(workBucket('aj-345', '  ')).toBeNull();
    // The same condition that nulls the key — so a null key never reaches bucket matching.
    expect(workKey(null, 'en-us', 'th', 'translation')).toBeNull();
  });
});
