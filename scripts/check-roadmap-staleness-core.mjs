// #1398 — pure logic for the ROADMAP staleness heartbeat (no fs). Testable in
// isolation.

// Matches a line like:  **Last reviewed:** 2026-06-27
const LAST_REVIEWED_RE = /\*\*Last reviewed:\*\*\s*(\d{4}-\d{2}-\d{2})/i;

/**
 * @param {string} text  the ROADMAP.md contents
 * @param {{ weeks: number, now?: Date }} opts
 * @returns {{ found: boolean, lastReviewed?: string, daysOld?: number, stale?: boolean }}
 */
export function evaluateStaleness(text, { weeks, now = new Date() }) {
  const m = LAST_REVIEWED_RE.exec(text ?? "");
  if (!m) return { found: false };

  const lastReviewed = m[1];
  const reviewedMs = Date.parse(`${lastReviewed}T00:00:00Z`);
  if (Number.isNaN(reviewedMs)) return { found: false };

  const nowMs = now.getTime();
  const daysOld = Math.floor((nowMs - reviewedMs) / (24 * 60 * 60 * 1000));
  const thresholdDays = weeks * 7;

  return {
    found: true,
    lastReviewed,
    daysOld,
    stale: daysOld > thresholdDays,
  };
}
