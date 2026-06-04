// Pure alert-diff: which alerts does HEAD introduce that BASE didn't have?
// Engine-agnostic — operates on the normalized alert shape
// { pkg, version, type, severity, title, url }.

export function alertKey(alert) {
  return `${alert.pkg}@${alert.version}:${alert.type}`;
}

// Returns head alerts whose key isn't in base, de-duplicated by key — Socket
// emits the same alert type once per occurrence (e.g. envVars found in two
// files), which would otherwise show as duplicate rows.
export function diffAlerts(headAlerts, baseAlerts) {
  const baseKeys = new Set(baseAlerts.map(alertKey));
  const seen = new Set();
  const out = [];
  for (const a of headAlerts) {
    const k = alertKey(a);
    if (baseKeys.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}
