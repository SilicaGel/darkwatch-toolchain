import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isBlocking, shouldFailGate, ALLOW_MARKER } from "./gate.mjs";

// Alert factory — carries Socket's per-alert org-policy `action`.
const a = (type, action = "ignore", severity = "low") => ({
  pkg: "p",
  version: "1.0.0",
  type,
  severity,
  action,
  title: type,
  url: "",
});

describe("isBlocking", () => {
  it("blocks when Socket's policy verdict is `error`", () => {
    assert.equal(isBlocking(a("networkAccess", "error")), true);
  });
  it("also blocks the `block` action variant", () => {
    assert.equal(isBlocking(a("networkAccess", "block")), true);
  });
  it("blocks malware-family types regardless of action (defense-in-depth floor)", () => {
    assert.equal(isBlocking(a("malware", "ignore")), true);
    assert.equal(isBlocking(a("gptMalware", "ignore")), true);
  });
  it("does NOT block normal supply-chain signals at ignore/monitor", () => {
    assert.equal(isBlocking(a("networkAccess", "ignore")), false);
    assert.equal(isBlocking(a("installScripts", "monitor")), false);
    // The baseline's only high-severity finding (resend unstableOwnership) is
    // action:monitor — high severity alone must not block.
    assert.equal(isBlocking(a("unstableOwnership", "monitor", "high")), false);
  });
});

describe("shouldFailGate", () => {
  it("passes when no net-new blocking alerts", () => {
    assert.deepEqual(shouldFailGate({ netNew: [a("networkAccess", "ignore")], prTitle: "x" }), {
      fail: false,
      reason: "no net-new blocking alerts",
    });
  });
  it("fails on a net-new error-action alert", () => {
    assert.equal(
      shouldFailGate({ netNew: [a("installScripts", "error")], prTitle: "x" }).fail,
      true,
    );
  });
  it("fails on a net-new malware-floor alert even at action:ignore", () => {
    assert.equal(shouldFailGate({ netNew: [a("malware", "ignore")], prTitle: "x" }).fail, true);
  });
  it("escape hatch in PR title skips the gate", () => {
    assert.equal(
      shouldFailGate({ netNew: [a("malware", "ignore")], prTitle: `fix stuff ${ALLOW_MARKER}` })
        .fail,
      false,
    );
  });
});
