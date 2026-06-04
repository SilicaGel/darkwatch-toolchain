// Pure alert-diff: which alerts does HEAD introduce that BASE didn't have?
// Engine-agnostic — operates on the normalized alert shape
// { pkg, version, type, severity, title, url }.

export function alertKey(alert) {
  return `${alert.pkg}@${alert.version}:${alert.type}`;
}

export function diffAlerts(headAlerts, baseAlerts) {
  const baseKeys = new Set(baseAlerts.map(alertKey));
  return headAlerts.filter((a) => !baseKeys.has(alertKey(a)));
}
