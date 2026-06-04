import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSocketAlerts, parseDiffAdded } from "./parse-socket.mjs";

const raw = JSON.parse(
  readFileSync(new URL("./__fixtures__/socket-scan-sample.json", import.meta.url)),
);
const diffRaw = JSON.parse(
  readFileSync(new URL("./__fixtures__/socket-scan-diff-sample.json", import.meta.url)),
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

describe("parseDiffAdded", () => {
  it("flattens data.artifacts.added[] packages into normalized alerts", () => {
    const { alerts, found } = parseDiffAdded(diffRaw);
    assert.equal(found, true);
    assert.ok(alerts.length > 0);
    for (const al of alerts) {
      for (const k of ["pkg", "version", "type", "severity", "action"]) assert.ok(al[k] !== undefined, `missing ${k}`);
    }
  });
  it("found=false + surfaces top-level keys when the added list isn't located", () => {
    const r = parseDiffAdded({ ok: true, data: { somethingElse: 1 } });
    assert.equal(r.found, false);
    assert.deepEqual(r.alerts, []);
    assert.deepEqual(r.shapeKeys, ["ok", "data"]);
  });
});
