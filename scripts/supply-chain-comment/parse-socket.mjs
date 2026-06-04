// Normalize Socket `scan view --json` output into the internal alert shape:
//   { pkg, version, type, severity, action, category, title, url }
//
// Socket's shape (from the #723 spike fixture):
//   { ok, data: [ { name, version, type, alerts: [ { type, severity,
//                   category, action, props, ... } ], score, ... } ] }
// `action` is Socket's per-alert org-policy verdict (ignore | monitor | warn |
// error) — the gate keys on it.

function humanize(type) {
  return String(type ?? "alert")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}

export function parseSocketAlerts(raw) {
  const out = [];
  for (const p of raw?.data ?? []) {
    for (const al of p.alerts ?? []) {
      out.push({
        pkg: p.name,
        version: p.version,
        type: al.type,
        severity: al.severity ?? "low",
        action: al.action ?? "ignore",
        category: al.category ?? "",
        title: humanize(al.type),
        url: p.name ? `https://socket.dev/npm/package/${p.name}` : "",
      });
    }
  }
  return out;
}
