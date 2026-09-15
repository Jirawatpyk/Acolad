import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FR-007: the bot never declines an offer. Unwanted offers are left to expire.
 *
 * This is a static check rather than a behavioural one because declining is irreversible in
 * the same way claiming is — there is no test that can safely prove the bot "would not"
 * decline by letting it try. What can be proved is that the capability is absent from the
 * source entirely, which is the discipline that kept the capture probe provably read-only,
 * and the recon note records the endpoint it must never reach: `POST .../<offerId>/decline`.
 *
 * The check covers `src/straker/` only. Test files are excluded on purpose: prose about
 * declining is how a reviewer explains the rule, and forbidding the word there would push
 * people into writing worse comments rather than into writing safer code.
 */

const STRAKER_SRC = join(process.cwd(), 'src', 'straker');

function typescriptFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...typescriptFilesUnder(path));
    else if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('the bot has no way to decline an offer (FR-007)', () => {
  const files = typescriptFilesUnder(STRAKER_SRC);

  it('is actually reading the Straker source, so an empty sweep cannot pass as clean', () => {
    // Guard the guard. A check that silently stops finding files reports success forever —
    // the same shape as a coverage threshold group that matches nothing and reports 100%,
    // which this project hit once already. Anchor on files that must exist.
    // Anchored on modules that exist and are not in flight: the transport (the only place
    // that can reach an endpoint at all), the offer reader, and the outcome model.
    expect(files.length).toBeGreaterThan(5);
    expect(files.map((f) => f.split(/[\\/]/).pop())).toEqual(
      expect.arrayContaining(['httpClient.ts', 'offersApi.ts', 'claimOutcome.ts']),
    );
  });

  it('mentions declining nowhere in src/straker, endpoint or verb', () => {
    const offenders = files.filter((f) => /decline/i.test(readFileSync(f, 'utf8')));

    expect(offenders).toEqual([]);
  });
});
