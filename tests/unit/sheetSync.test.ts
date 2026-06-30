import { describe, it, expect } from 'vitest';
import { hasMaterialSheetChange } from '../../src/reporting/sheetSync.js';

describe('hasMaterialSheetChange', () => {
  it('returns true when dueDate changed', () => {
    expect(hasMaterialSheetChange([{ field: 'dueDate' }])).toBe(true);
  });

  it('returns true when words changed', () => {
    expect(hasMaterialSheetChange([{ field: 'words' }])).toBe(true);
  });

  it('returns true when fileWwc changed (logged to the Sheet)', () => {
    expect(hasMaterialSheetChange([{ field: 'fileWwc' }])).toBe(true);
  });

  it('returns false for non-material fields (projectName, role)', () => {
    expect(hasMaterialSheetChange([{ field: 'projectName' }, { field: 'role' }])).toBe(false);
  });

  it('returns false for empty changes array', () => {
    expect(hasMaterialSheetChange([])).toBe(false);
  });
});
