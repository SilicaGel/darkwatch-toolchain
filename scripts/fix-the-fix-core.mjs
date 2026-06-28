// #841 — pure logic for the fix-the-fix review (no network). Kept separate
// from fix-the-fix-review.mjs so it's unit-testable without hitting Forgejo.

/**
 * Given a Forgejo issue timeline (array of events, each `{ type, created_at }`),
 * return the FIRST close→reopen pair where the reopen happened within
 * `windowDays` of the close. Returns null if no such tight loop exists.
 *
 * Forgejo emits `close` and `reopen` timeline event types. We sort by time
 * and walk forward: the first reopen that lands within the window after a
 * preceding close is a "fix-the-fix" signal.
 */
export function pairCloseReopen(events, windowDays) {
  const relevant = (events ?? [])
    .filter((e) => e && (e.type === "close" || e.type === "reopen") && e.created_at)
    .map((e) => ({ type: e.type, at: new Date(e.created_at).getTime() }))
    .filter((e) => Number.isFinite(e.at))
    .sort((a, b) => a.at - b.at);

  let lastClose = null;
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  for (const e of relevant) {
    if (e.type === "close") {
      lastClose = e.at;
    } else if (e.type === "reopen" && lastClose != null) {
      const delta = e.at - lastClose;
      if (delta >= 0 && delta <= windowMs) {
        return {
          closedAt: new Date(lastClose).toISOString(),
          reopenedAt: new Date(e.at).toISOString(),
          daysToReopen: Math.round((delta / (24 * 60 * 60 * 1000)) * 10) / 10,
        };
      }
      // Reopen outside the window resets the "open" state; a later close can
      // still start a fresh tight loop.
      lastClose = null;
    }
  }
  return null;
}

/**
 * Build the report object (and human text) from the list of hits.
 */
export function summarize(hits, args) {
  const sorted = [...hits].sort((a, b) => a.daysToReopen - b.daysToReopen);
  const lines = [];
  lines.push(
    `fix-the-fix review — issues reopened within ${args.days}d of close (closes since ${args.since})`,
  );
  lines.push("=".repeat(72));
  if (sorted.length === 0) {
    lines.push("No tight close→reopen loops found in the window. (Good sign.)");
  } else {
    for (const h of sorted) {
      lines.push(`#${h.number}  reopened ${h.daysToReopen}d after close — ${h.title}`);
    }
    lines.push("-".repeat(72));
    lines.push(`${sorted.length} issue(s). Next steps:`);
    lines.push("  1. Read each issue's reopen comment for the root cause.");
    lines.push(
      "  2. Group by root cause (acceptance-vs-intent, missing surface check, brittle test, env drift).",
    );
    lines.push(
      "  3. If a cluster points at a skill, file a sub-issue / PR for that skill (qa-check, queue-batches, ship).",
    );
    lines.push("  4. Log this pass in docs/fix-the-fix-log.md so passes are comparable.");
  }
  return { hits: sorted, count: sorted.length, params: args, text: lines.join("\n") };
}
