const BE_OFFSET_YEARS = 543;
const BANGKOK_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;

/**
 * Parses a Com7 `CrTime`/`UTime` string (Buddhist-Era year, Asia/Bangkok
 * wall clock, e.g. "2569-05-14 14:12:43.573") into the correct CE epoch ms.
 * Manual string parsing on purpose — never let JS `Date` interpret the raw
 * BE-numbered string, since its local-timezone semantics are unreliable
 * across machines/processes.
 */
export function beDateStringToEpochMs(dateString) {
  const m = DATETIME_RE.exec(dateString);
  if (!m) throw new Error(`unrecognized datetime format: ${dateString}`);
  const [, y, mo, d, h, mi, s, msRaw] = m;
  const ceYear = Number(y) - BE_OFFSET_YEARS;
  const ms = msRaw ? Number(msRaw.padEnd(3, '0').slice(0, 3)) : 0;
  const utcMsAtBangkokWallClock = Date.UTC(ceYear, Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  return utcMsAtBangkokWallClock - BANGKOK_UTC_OFFSET_MS;
}

/** Formats epoch ms as a whole-second UTC "YYYY-MM-DD HH:mm:ss" string for MySQL DATETIME columns. */
export function epochMsToUtcDatetimeString(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Shift a Buddhist-Era wall-clock datetime string to CE by adjusting ONLY the
 * year (−543), leaving the clock untouched. Used to turn a source `UTime`
 * (BE, Asia/Bangkok wall clock) into the CE watermark string stored in
 * sync_state. Deliberately NOT via epoch/UTC — that would shift the clock 7h.
 */
export function beDatetimeToCeString(beString) {
  const s = String(beString);
  return `${Number(s.slice(0, 4)) - BE_OFFSET_YEARS}${s.slice(4)}`;
}
