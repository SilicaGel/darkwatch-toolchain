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
  it("renders the clean state with the marker when no net-new alerts", () => {
    const body = buildComment({ netNew: [], blocked: false });
    assert.match(body, new RegExp(MARKER));
    assert.match(body, /No new supply-chain alerts/i);
  });
  it("renders a table row per net-new alert and flags a blocked PR", () => {
    const body = buildComment({ netNew: [a("evil", "malware", "critical")], blocked: true });
    assert.match(body, /evil/);
    assert.match(body, /malware/);
    assert.match(body, /critical/);
    assert.match(body, /blocked/i);
    assert.match(body, /\[allow-deps\]/); // documents the escape hatch
  });
  it("marks informational findings as non-blocking", () => {
    const body = buildComment({ netNew: [a("newish", "newAuthor")], blocked: false });
    assert.match(body, /Informational/i);
    assert.doesNotMatch(body, /blocked/i);
  });
});
