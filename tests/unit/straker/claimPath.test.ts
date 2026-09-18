import { describe, expect, it } from 'vitest';
import { claimRequestPath } from '../../../src/straker/claim.js';

/**
 * Where a claim is sent (contract §4). Confirmed 2026-09-18 from the portal's own web app,
 * whose Accept button calls `POST /api/vendors/{vendorId}/job-offers/{obj_id}/accept`.
 *
 * The first real claim went to a guessed `/claim` and the portal answered `404 Not Found`
 * while the offer stayed open for two more minutes: the route did not exist, so every claim
 * the bot could ever send would have failed the same way.
 */
describe('claimRequestPath', () => {
  it('addresses the accept action the portal web app uses', () => {
    expect(claimRequestPath({ vendorId: 'v-1', offerId: 'o-1' })).toBe(
      '/api/vendors/v-1/job-offers/o-1/accept',
    );
  });

  it('percent-encodes both ids, so a stray slash cannot address another resource', () => {
    expect(claimRequestPath({ vendorId: 'a/b', offerId: 'c/d' })).toBe(
      '/api/vendors/a%2Fb/job-offers/c%2Fd/accept',
    );
  });
});
