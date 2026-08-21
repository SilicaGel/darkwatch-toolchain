import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveEventName } from "./docs-only-core.mjs";

describe("resolveEventName", () => {
  // The regression this module exists for: test.yml runs as a workflow_call
  // callee, so its event_name is 'workflow_call' even underneath a real PR.
  it("reads a callee under a PR as a pull request, despite event_name", () => {
    assert.equal(
      resolveEventName({ GITHUB_EVENT_NAME: "workflow_call", PR_NUMBER: "2542" }),
      "pull_request",
    );
  });

  it("reads an ordinary PR job as a pull request", () => {
    assert.equal(
      resolveEventName({ GITHUB_EVENT_NAME: "pull_request", PR_NUMBER: "2542" }),
      "pull_request",
    );
  });

  // Everything below must NOT read as a pull request: decide() runs the full
  // suite for any other event, and that is the safe direction.
  it("leaves a push run alone", () => {
    assert.equal(resolveEventName({ GITHUB_EVENT_NAME: "push", PR_NUMBER: "" }), "push");
  });

  it("leaves a schedule run alone", () => {
    assert.equal(resolveEventName({ GITHUB_EVENT_NAME: "schedule" }), "schedule");
  });

  it("does not invent a PR from a missing or zero number", () => {
    assert.equal(resolveEventName({ GITHUB_EVENT_NAME: "workflow_call" }), "workflow_call");
    assert.equal(
      resolveEventName({ GITHUB_EVENT_NAME: "workflow_call", PR_NUMBER: "0" }),
      "workflow_call",
    );
    assert.equal(
      resolveEventName({ GITHUB_EVENT_NAME: "workflow_call", PR_NUMBER: "   " }),
      "workflow_call",
    );
  });

  it("returns an empty string rather than throwing on an empty env", () => {
    assert.equal(resolveEventName(), "");
    assert.equal(resolveEventName({}), "");
  });
});
