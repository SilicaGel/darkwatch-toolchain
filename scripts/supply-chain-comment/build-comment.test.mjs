import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildComment, MARKER } from "./build-comment.mjs";

const a = (pkg, type, severity = "high") => ({
  pkg,
  version: "1.0.0",
  type,
  severity,
  title: type,
  url: `https://socket.dev/npm/package/${pkg}`,
});

describe("buildComment", () => {
  it("renders the clean state with the marker + counts when no net-new alerts", () => {
    const body = buildComment({
      blocking: [],
      informational: [],
      blocked: false,
      counts: { added: 0, netNew: 0 },
    });
    assert.match(body, new RegExp(MARKER));
    assert.match(body, /No new supply-chain alerts/i);
    assert.match(body, /scan-diff: 0 added/);
  });
  it("lists blocking findings in a visible table and flags the PR blocked", () => {
    const body = buildComment({
      blocking: [a("evil", "malware", "critical")],
      informational: [],
      blocked: true,
    });
    assert.match(body, /Blocking/);
    assert.match(body, /evil/);
    assert.match(body, /critical/);
    assert.match(body, /blocked/i);
    assert.match(body, /\[allow-deps\]/);
  });
  it("collapses informational findings into a details block with a count", () => {
    const body = buildComment({
      blocking: [],
      informational: [a("x", "envVars", "low"), a("y", "urlStrings", "low")],
      blocked: false,
      counts: { added: 2, netNew: 2 },
    });
    assert.match(body, /Informational findings — none block/i);
    assert.match(body, /<details>/);
    assert.match(body, /2 informational findings/);
    assert.doesNotMatch(body, /blocked/i);
  });
});
