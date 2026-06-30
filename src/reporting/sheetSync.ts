/**
 * True when a Sheet-material display field changed on a still-visible job. XTM can
 * populate the Due date (and Words / File WWC) AFTER the bot's last Sheet write (which only
 * fires on a lifecycle transition), so a changed dueDate/words/fileWwc must re-sync the Sheet.
 * Other fields already flow through transitions, so they are intentionally excluded (YAGNI).
 */
const MATERIAL_SHEET_FIELDS = new Set(['dueDate', 'words', 'fileWwc']);
export function hasMaterialSheetChange(changes: { field: string }[]): boolean {
  return changes.some((c) => MATERIAL_SHEET_FIELDS.has(c.field));
}
