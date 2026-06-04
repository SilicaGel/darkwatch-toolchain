import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSocketAlerts } from "./parse-socket.mjs";

const raw = JSON.parse(
  readFileSync(new URL("./__fixtures__/socket-scan-sample.json", import.meta.url)),
);

describe("parseSocketAlerts", () => {
  it("flattens scan-view data[] packages into normalized alerts", () => {
    const alerts = parseSocketAlerts(raw);
    assert.ok(alerts.length > 0);
    for (const al of alerts) {
      for (const k of ["pkg", "version", "type", "severity", "action"]) {
        assert.ok(al[k] !== undefined && al[k] !== null, `missing ${k}`);
      }
    }
  });
  it("carries severity + action through from the Socket alert (resend high/monitor)", () => {
    const r = parseSocketAlerts(raw).find((a) => a.pkg === "resend" && a.type === "unstableOwnership");
    assert.ok(r, "expected resend unstableOwnership alert in fixture");
    assert.equal(r.severity, "high");
    assert.equal(r.action, "monitor");
  });
  it("humanizes the type into a readable title", () => {
    const r = parseSocketAlerts(raw).find((a) => a.type === "unstableOwnership");
    assert.equal(r.title, "Unstable ownership");
  });
  it("returns [] for empty / malformed input (fail-soft)", () => {
    assert.deepEqual(parseSocketAlerts({}), []);
    assert.deepEqual(parseSocketAlerts(null), []);
    assert.deepEqual(parseSocketAlerts({ data: [{ name: "x", version: "1", alerts: [] }] }), []);
  });
});
