// Normalize Socket CLI output into the internal alert shape:
//   { pkg, version, type, severity, action, category, title, url }
//
// Socket's package shape (from the #723 spike fixture):
//   { name, version, type, alerts: [ { type, severity, category, action, ... } ] }
// `action` is Socket's per-alert org-policy verdict (ignore | monitor | warn |
// error) — the gate keys on it.

function humanize(type) {
  return String(type ?? "alert")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}

// Flatten a list of Socket "package" objects into normalized alerts.
function packagesToAlerts(packages) {
  const out = [];
  for (const p of packages ?? []) {
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

// `scan view --json` → { ok, data: [ package, ... ] }
export function parseSocketAlerts(raw) {
  return packagesToAlerts(raw?.data);
}

// `scan diff --json <olderId> <newerId>` → the server-computed delta.
// Socket's exact key for the "added" package list is uncertain, so try the
// plausible shapes and report what we found. Returns:
//   { alerts, found, shapeKeys } — `alerts` is the normalized added alerts,
//   `found` is whether we located an "added" array, `shapeKeys` are the raw
//   top-level keys (surfaced in the PR comment when found === false so the
//   real shape reveals itself on the first CI run, given #1119 log-blindness).
export function parseDiffAdded(raw) {
  const candidates = [
    raw?.data?.artifacts?.added, // confirmed shape (#723 scan-diff spike)
    raw?.added,
    raw?.data?.added,
    raw?.diff?.added,
    raw?.artifacts?.added,
    raw?.data?.diff?.added,
  ];
  const added = candidates.find((c) => Array.isArray(c));
  const shapeKeys = raw && typeof raw === "object" ? Object.keys(raw) : [];
  if (!Array.isArray(added)) {
    return { alerts: [], found: false, shapeKeys };
  }
  // `added` items may be packages (have `.alerts`) or bare alerts (have `.type`).
  const looksLikePackages = added.some((x) => x && Array.isArray(x.alerts));
  const alerts = looksLikePackages
    ? packagesToAlerts(added)
    : packagesToAlerts(added.map((a) => ({ name: a.pkg ?? a.name, version: a.version, alerts: [a] })));
  return { alerts, found: true, shapeKeys };
}
