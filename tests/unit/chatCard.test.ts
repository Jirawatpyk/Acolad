import { describe, it, expect } from 'vitest';
import { truncate, buildCard } from '../../src/reporting/chatCard.js';

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------
describe('truncate', () => {
  it('returns the string unchanged when it is short enough', () => {
    expect(truncate('short')).toBe('short');
  });

  it('truncates a long string to ≤ 120 chars and ends with …', () => {
    const s = truncate('x'.repeat(200));
    expect(s.length).toBeLessThanOrEqual(120);
    expect(s.endsWith('…')).toBe(true);
  });

  it('respects a custom max', () => {
    const s = truncate('abcdef', 4);
    expect(s.length).toBeLessThanOrEqual(4);
    expect(s.endsWith('…')).toBe(true);
  });

  it('does not truncate a string exactly at max', () => {
    expect(truncate('abc', 3)).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// Helper: extract the first card entry (asserts it exists)
// ---------------------------------------------------------------------------
type AnyEntry = { cardId: string; card: AnyCard };
type AnyCard = { header: { title: string; subtitle?: string }; sections: AnySection[] };
type AnySection = { widgets: AnyWidget[] };
type AnyWidget = {
  decoratedText?: { topLabel?: string; text: string };
  buttonList?: { buttons: { text: string; onClick: { openLink: { url: string } } }[] };
};

function firstEntry(result: { cardsV2: unknown[] }): AnyEntry {
  const entry = result.cardsV2[0] as AnyEntry | undefined;
  if (!entry) throw new Error('cardsV2 is empty');
  return entry;
}

// ---------------------------------------------------------------------------
// buildCard — basic shape
// ---------------------------------------------------------------------------
describe('buildCard — shape', () => {
  it('returns { cardsV2: [{ cardId, card: { header, sections } }] }', () => {
    const result = buildCard({
      cardId: 'card-001',
      headerTitle: 'Hello',
      rows: [{ label: 'Status', value: 'OK' }],
    });

    expect(result).toHaveProperty('cardsV2');
    expect(Array.isArray(result.cardsV2)).toBe(true);
    expect(result.cardsV2).toHaveLength(1);

    const entry = firstEntry(result);
    expect(entry.cardId).toBe('card-001');
    expect(entry.card.header.title).toBe('Hello');
    expect(Array.isArray(entry.card.sections)).toBe(true);
  });

  it('includes subtitle when provided', () => {
    const result = buildCard({
      cardId: 'c1',
      headerTitle: 'T',
      headerSubtitle: 'Sub',
      rows: [],
    });
    expect(firstEntry(result).card.header.subtitle).toBe('Sub');
  });

  it('omits subtitle when not provided', () => {
    const result = buildCard({ cardId: 'c1', headerTitle: 'T', rows: [] });
    expect(firstEntry(result).card.header.subtitle).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildCard — null value → em dash
// ---------------------------------------------------------------------------
describe('buildCard — null value', () => {
  it('renders null value as — (em dash) in the widget text', () => {
    const result = buildCard({
      cardId: 'c1',
      headerTitle: 'T',
      rows: [{ label: 'Field', value: null }],
    });

    const widgets = firstEntry(result).card.sections[0]?.widgets ?? [];
    const w = widgets[0];
    expect(w?.decoratedText?.text).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// buildCard — long value gets truncated
// ---------------------------------------------------------------------------
describe('buildCard — value truncation', () => {
  it('truncates a value longer than 120 chars to end with …', () => {
    const longValue = 'v'.repeat(200);
    const result = buildCard({
      cardId: 'c1',
      headerTitle: 'T',
      rows: [{ label: 'Field', value: longValue }],
    });

    const widgets = firstEntry(result).card.sections[0]?.widgets ?? [];
    const text = widgets[0]?.decoratedText?.text ?? '';
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text.endsWith('…')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildCard — buttonUrl
// ---------------------------------------------------------------------------
describe('buildCard — button', () => {
  it('adds a buttonList section when buttonUrl is provided', () => {
    const result = buildCard({
      cardId: 'c1',
      headerTitle: 'T',
      rows: [],
      buttonUrl: 'https://example.com',
      buttonText: 'Go there',
    });

    const allWidgets = firstEntry(result).card.sections.flatMap((s) => s.widgets);
    const buttonWidget = allWidgets.find((w) => w.buttonList != null);
    expect(buttonWidget).toBeDefined();

    const btn = buttonWidget?.buttonList?.buttons[0];
    expect(btn?.onClick.openLink.url).toBe('https://example.com');
    expect(btn?.text).toBe('Go there');
  });

  it('uses "Open in XTM" as default button text when buttonText is absent', () => {
    const result = buildCard({
      cardId: 'c1',
      headerTitle: 'T',
      rows: [],
      buttonUrl: 'https://example.com',
    });

    const allWidgets = firstEntry(result).card.sections.flatMap((s) => s.widgets);
    const buttonWidget = allWidgets.find((w) => w.buttonList != null);
    expect(buttonWidget?.buttonList?.buttons[0]?.text).toBe('Open in XTM');
  });

  it('has NO buttonList section when buttonUrl is absent', () => {
    const result = buildCard({ cardId: 'c1', headerTitle: 'T', rows: [] });

    const allWidgets = firstEntry(result).card.sections.flatMap((s) => s.widgets);
    const buttonWidget = allWidgets.find((w) => w.buttonList != null);
    expect(buttonWidget).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildCard — >20 rows → "…and N more" marker
// ---------------------------------------------------------------------------
describe('buildCard — rows > 20', () => {
  const makeRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ label: `L${i}`, value: `V${i}` }));

  it('renders only 20 row-widgets plus a "…and N more" marker', () => {
    const rows = makeRows(25);
    const result = buildCard({ cardId: 'c1', headerTitle: 'T', rows });

    const widgets = firstEntry(result).card.sections[0]?.widgets ?? [];
    // 20 data rows + 1 "…and 5 more" marker = 21 total
    expect(widgets).toHaveLength(21);
    expect(widgets[20]?.decoratedText?.text).toBe('…and 5 more');
  });

  it('renders exactly 20 rows without a marker when rows.length === 20', () => {
    const rows = makeRows(20);
    const result = buildCard({ cardId: 'c1', headerTitle: 'T', rows });

    const widgets = firstEntry(result).card.sections[0]?.widgets ?? [];
    expect(widgets).toHaveLength(20);
    // last widget should NOT be a "…and" marker
    expect(widgets[19]?.decoratedText?.text).not.toMatch(/^…and/);
  });
});

// ---------------------------------------------------------------------------
// buildCard — size guard (< 32 KB hard cap, safety margin 30 KB)
// ---------------------------------------------------------------------------
describe('buildCard — size guard', () => {
  it('keeps JSON.stringify output < 32768 bytes even with 20 rows of ~2 KB values', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      label: `Label-${i}`,
      value: 'x'.repeat(2000),
    }));

    const result = buildCard({
      cardId: 'size-test',
      headerTitle: 'Size Guard Test',
      rows,
    });

    const serialized = JSON.stringify(result);
    expect(serialized.length).toBeLessThan(32768);
  });

  it('keeps the result strictly under MAX_BYTES (30000) when values are large', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      label: `L${i}`,
      value: 'a'.repeat(2000),
    }));

    const result = buildCard({ cardId: 'c1', headerTitle: 'T', rows });
    expect(JSON.stringify(result).length).toBeLessThan(30000);
  });
});
