const BE_OFFSET_YEARS = 543;

/**
 * The CE year a Com7 row belongs to, derived from its immutable `CrTime`
 * (Buddhist-Era, §Decision #9 — CrTime never moves, so a row never changes
 * base). Used to route each incremental row to its yearly base. Parses only
 * the leading BE year; never lets JS `Date` reinterpret the raw string.
 */
export function crYear(row) {
  const s = typeof row.CrTime === 'string' ? row.CrTime : row.CrTime.toISOString();
  return Number(s.slice(0, 4)) - BE_OFFSET_YEARS;
}
