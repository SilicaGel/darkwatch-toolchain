// #2409 — the ordering rule is the whole point of this script, so the test
// that earns its place is the one a lexical sort FAILS.
import { describe, it, expect } from "vitest";
import { parseTagVersion, newestReleaseTag } from "./newest-release-tag-core.mjs";

describe("parseTagVersion", () => {
  it("parses a release tag into a numeric triple", () => {
    expect(parseTagVersion("v0.198.0")).toEqual([0, 198, 0]);
    expect(parseTagVersion("v1.0.0")).toEqual([1, 0, 0]);
  });

  it("tolerates surrounding whitespace (git tag -l output is line-based)", () => {
    expect(parseTagVersion("  v0.198.0\n")).toEqual([0, 198, 0]);
  });

  it("returns null for anything that is not a plain vMAJOR.MINOR.PATCH tag", () => {
    for (const bad of [
      "v0.198",
      "0.198.0",
      "v0.198.0-rc1",
      "release-0.198.0",
      "v1.2.3.4",
      "",
      "vx.y.z",
    ]) {
      expect(parseTagVersion(bad), bad).toBeNull();
    }
  });
});

describe("newestReleaseTag", () => {
  // THE test. `sort`/`sort -V`-by-string ranks v0.99.0 above v0.100.0 because
  // '9' > '1' at the third character. We are at 0.198.x, so this is not a
  // future hazard — a lexical implementation is wrong on today's tag list.
  it("orders by semver, not lexically (v0.100.0 beats v0.99.0)", () => {
    expect(newestReleaseTag(["v0.99.0", "v0.100.0"])).toBe("v0.100.0");
    expect(newestReleaseTag(["v0.100.0", "v0.99.0"])).toBe("v0.100.0");
  });

  it("compares patch and minor numerically, not by digit count", () => {
    expect(newestReleaseTag(["v0.198.9", "v0.198.10"])).toBe("v0.198.10");
    expect(newestReleaseTag(["v0.9.0", "v0.198.0"])).toBe("v0.198.0");
  });

  it("respects major over minor", () => {
    expect(newestReleaseTag(["v0.999.999", "v1.0.0"])).toBe("v1.0.0");
  });

  it("ignores non-release tags mixed into the list", () => {
    expect(newestReleaseTag(["v0.198.0", "nightly", "v0.198.1-rc1", "backup/v9.9.9"])).toBe(
      "v0.198.0",
    );
  });

  // A null here MUST mean "fail the deploy", never "deploy main" — the whole
  // point of pinning is that the deployed code and the reported version match.
  it("returns null when there is no parseable release tag", () => {
    expect(newestReleaseTag([])).toBeNull();
    expect(newestReleaseTag(undefined)).toBeNull();
    expect(newestReleaseTag(["nightly", "not-a-tag"])).toBeNull();
  });

  it("is stable on the single-tag bootstrap case", () => {
    expect(newestReleaseTag(["v0.198.0"])).toBe("v0.198.0");
  });
});
