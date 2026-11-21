/**
 * Escapes one CSV cell and neutralizes spreadsheet formulas.
 *
 * Excel/LibreOffice execute cells starting with `=`, `+`, `-` or `@` even when
 * the value came from a username or an imported real name. Prefixing a single
 * quote keeps the displayed text intact and stops formula evaluation.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
