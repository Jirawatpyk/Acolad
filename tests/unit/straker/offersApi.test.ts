import { describe, expect, it, vi } from 'vitest';
import { listOpenOffers } from '../../../src/straker/offersApi.js';
import type { StrakerHttpClient } from '../../../src/straker/httpClient.js';

function client(reply: unknown): StrakerHttpClient {
  return {
    getJson: vi.fn().mockResolvedValue(reply),
    // Answers the same reply through either read door, so these stay tests of the shape
    // guards rather than of which entry point the caller happens to use.
    getJsonWithBackoff: vi.fn().mockResolvedValue(reply),
    postJson: vi.fn(),
    lastRateLimit: () => null,
  };
}

describe('listOpenOffers', () => {
  it('asks for the open list of the vendor it was given', async () => {
    const c = client([]);

    await listOpenOffers(c, 'vendor-9');

    expect(c.getJson).toHaveBeenCalledWith('/api/vendors/vendor-9/job-offers?status=open');
  });

  it('fails loud if the reply stops being a bare array, rather than reading it as zero offers', async () => {
    const c = client({ items: [{ obj_id: 'off-1' }], total: 1 });

    await expect(listOpenOffers(c, 'vendor-9')).rejects.toThrow(/array/i);
  });

  it('fails loud when an entry has no obj_id, since obj_id is the offer identity', async () => {
    const c = client([{ job_ref: 'JR-1' }]);

    await expect(listOpenOffers(c, 'vendor-9')).rejects.toThrow(/obj_id/);
  });

  it('keeps the first of a repeated obj_id and names the repeats, when asked to', async () => {
    // One offer listed twice would be decided twice and claimed twice in one cycle — the
    // in-process guard is consulted before the decisions, not between them.
    const c = client([
      { obj_id: 'a', words: 1 },
      { obj_id: 'b' },
      { obj_id: 'a', words: 999 },
      { obj_id: 'a', words: 7 },
    ]);
    const onDuplicate = vi.fn();

    const offers = await listOpenOffers(c, 'vendor-9', { onDuplicate });

    expect(offers).toEqual([{ obj_id: 'a', words: 1 }, { obj_id: 'b' }]);
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledWith(['a']);
  });

  it('says nothing when every obj_id is unique', async () => {
    const onDuplicate = vi.fn();

    await listOpenOffers(client([{ obj_id: 'a' }, { obj_id: 'b' }]), 'vendor-9', { onDuplicate });

    expect(onDuplicate).not.toHaveBeenCalled();
  });

  it('leaves the reply untouched without the option, which is how the capture probe reads', async () => {
    const reply = [{ obj_id: 'a' }, { obj_id: 'a' }];

    expect(await listOpenOffers(client(reply), 'vendor-9')).toEqual(reply);
  });
});
