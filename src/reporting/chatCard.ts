/**
 * Pure Google Chat cardsV2 card builder.
 *
 * - No I/O, no side effects — safe to unit-test without stubs.
 * - Enforces Google Chat's 32 KB hard cap via a SIZE GUARD loop that drops
 *   trailing row-widgets until the serialized card fits under MAX_BYTES
 *   (30 000, a ~6% safety margin).
 * - The "…and N more" overflow marker reflects the TOTAL number of hidden rows
 *   after both the MAX_ROWS cap and the size guard have run. The size guard
 *   recomputes N as `originalCount − renderedRowCount`, so N is always
 *   truthful: it counts every row not shown, whether dropped by the 20-row cap
 *   or by the size guard. The marker is omitted when no rows are hidden.
 */

const MAX_ROWS = 20;
const MAX_BYTES = 30_000; // safety margin under Google Chat's 32 KB hard cap

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Truncate a string to `max` characters, appending `…` if cut. */
export function truncate(s: string, max = 120): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ---------------------------------------------------------------------------
// Internal types (kept local — callers only see the opaque unknown[] shape)
// ---------------------------------------------------------------------------

interface DecoratedTextWidget {
  decoratedText: {
    topLabel?: string;
    text: string;
  };
}

interface ButtonListWidget {
  buttonList: {
    buttons: {
      text: string;
      onClick: { openLink: { url: string } };
    }[];
  };
}

type Widget = DecoratedTextWidget | ButtonListWidget;

interface Section {
  widgets: Widget[];
}

interface Card {
  header: { title: string; subtitle?: string };
  sections: Section[];
}

interface CardEntry {
  cardId: string;
  card: Card;
}

// ---------------------------------------------------------------------------
// buildCard
// ---------------------------------------------------------------------------

export interface CardRow {
  emoji?: string;
  label: string;
  value: string | null;
}

export interface BuildCardOptions {
  cardId: string;
  headerTitle: string;
  headerSubtitle?: string;
  rows: CardRow[];
  buttonText?: string;
  buttonUrl?: string;
}

export function buildCard(o: BuildCardOptions): { cardsV2: unknown[] } {
  const header: Card['header'] = {
    title: truncate(o.headerTitle, 200),
    ...(o.headerSubtitle !== undefined ? { subtitle: truncate(o.headerSubtitle, 200) } : {}),
  };

  // --- Build the button section (stable; never dropped by size guard) -------
  const buttonSection: Section | null = o.buttonUrl
    ? {
        widgets: [
          {
            buttonList: {
              buttons: [
                {
                  text: o.buttonText ?? 'Open in XTM',
                  onClick: { openLink: { url: o.buttonUrl } },
                },
              ],
            },
          } satisfies ButtonListWidget,
        ],
      }
    : null;

  // --- Apply MAX_ROWS cap ---------------------------------------------------
  const originalCount = o.rows.length;
  const cappedRows = o.rows.slice(0, MAX_ROWS);
  const overflowCount = originalCount - cappedRows.length; // > 0 when capped

  // --- Convert rows to decoratedText widgets --------------------------------
  const makeRowWidget = (row: CardRow): DecoratedTextWidget => ({
    decoratedText: {
      topLabel: truncate(row.emoji ? `${row.emoji} ${row.label}` : row.label, 100),
      text: truncate((row.value ?? '—') || '—'),
    },
  });

  const makeOverflowWidget = (n: number): DecoratedTextWidget => ({
    decoratedText: { text: `…and ${n} more` },
  });

  // Build a card object from a list of row widgets + optional overflow marker.
  const assembleCard = (
    rowWidgets: DecoratedTextWidget[],
    overflow: number,
  ): { cardsV2: unknown[] } => {
    const rowSection: Section = {
      widgets: [...rowWidgets, ...(overflow > 0 ? [makeOverflowWidget(overflow)] : [])],
    };

    const sections: Section[] = [rowSection, ...(buttonSection ? [buttonSection] : [])];

    const entry: CardEntry = { cardId: o.cardId, card: { header, sections } };
    return { cardsV2: [entry] };
  };

  // --- Size guard -----------------------------------------------------------
  // Start with all capped rows, then drop from the tail until we fit.
  let rowWidgets = cappedRows.map(makeRowWidget);

  let result = assembleCard(rowWidgets, overflowCount);

  while (JSON.stringify(result).length >= MAX_BYTES && rowWidgets.length > 0) {
    rowWidgets = rowWidgets.slice(0, rowWidgets.length - 1);
    // How many rows are now hidden in total?
    const totalDropped = originalCount - rowWidgets.length;
    result = assembleCard(rowWidgets, totalDropped > 0 ? totalDropped : 0);
  }

  // Terminal degraded path: if the card is STILL over the limit even with zero
  // row-widgets (e.g. a pathologically huge header), return a visibly degraded
  // card rather than silently returning an oversized payload. Keeps header +
  // button section; row section becomes a single warning widget.
  if (JSON.stringify(result).length >= MAX_BYTES) {
    const degradedRowSection: Section = {
      widgets: [{ decoratedText: { text: '⚠️ Content too large to display' } }],
    };
    const sections: Section[] = [degradedRowSection, ...(buttonSection ? [buttonSection] : [])];
    const entry: CardEntry = { cardId: o.cardId, card: { header, sections } };
    result = { cardsV2: [entry] };
  }

  return result;
}
