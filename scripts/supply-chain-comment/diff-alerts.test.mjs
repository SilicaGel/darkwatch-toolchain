import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { alertKey, diffAlerts } from "./diff-alerts.mjs";

const a = (pkg, version, type, severity = "high") => ({ pkg, version, type, severity, title: type, url: "" });

describe("alertKey", () => {
  it("keys by pkg@version:type", () => {
    assert.equal(alertKey(a("left-pad", "1.3.0", "malware")), "left-pad@1.3.0:malware");
  });
});

describe("diffAlerts", () => {
  it("returns alerts present in head but not base", () => {
    const base = [a("x", "1.0.0", "installScript")];
    const head = [a("x", "1.0.0", "installScript"), a("evil", "0.0.1", "malware")];
    const net = diffAlerts(head, base);
    assert.deepEqual(net.map(alertKey), ["evil@0.0.1:malware"]);
  });
  it("treats a version bump as net-new (same pkg, new version)", () => {
    const base = [a("x", "1.0.0", "newAuthor")];
    const head = [a("x", "2.0.0", "newAuthor")];
    assert.deepEqual(diffAlerts(head, base).map(alertKey), ["x@2.0.0:newAuthor"]);
  });
  it("returns [] when head introduces nothing new", () => {
    const base = [a("x", "1.0.0", "malware")];
    assert.deepEqual(diffAlerts(base, base), []);
  });
  it("de-dupes repeated same-key alerts (same pkg@version:type)", () => {
    const head = [a("react-is", "17.0.2", "envVars"), a("react-is", "17.0.2", "envVars")];
    assert.deepEqual(diffAlerts(head, []).map(alertKey), ["react-is@17.0.2:envVars"]);
  });
});
