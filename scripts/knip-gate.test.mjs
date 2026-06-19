// Tests for the pure offender-selection in knip-gate.mjs.
// Run: node --test scripts/knip-gate.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectNewOffenders } from "./knip-gate.mjs";

describe("selectNewOffenders", () => {
  // Mirrors the real scenario: knip reports pre-existing phantoms (in untouched
  // files) plus dead code the branch actually introduced (in changed files).
  const files = ["tests/scripts/smoke-walk.ts"]; // phantom unused file, untouched
  const issues = [
    // phantom: a devDep flagged on an untouched package.json
    { file: "server/package.json", devDependencies: ["yaml"] },
    // phantom: unused export in an untouched script
    { file: "scripts/image-gen/config.js", exports: ["MODEL_ROUTING"] },
    // introduced by the branch: unused exported types in changed files
    { file: "client/src/lib/splitWallForDoor.ts", types: ["WallKind", "WallSegment"] },
    { file: "server/src/repositories/mapWallsRepository.ts", types: ["SplitSegment"] },
  ];

  it("keeps only findings in files the branch changed (phantoms drop out)", () => {
    const changedFiles = new Set([
      "client/src/lib/splitWallForDoor.ts",
      "server/src/repositories/mapWallsRepository.ts",
    ]);
    const offenders = selectNewOffenders({ files, issues, changedFiles });
    assert.deepEqual(
      offenders.sort(),
      [
        "types: client/src/lib/splitWallForDoor.ts: WallKind",
        "types: client/src/lib/splitWallForDoor.ts: WallSegment",
        "types: server/src/repositories/mapWallsRepository.ts: SplitSegment",
      ].sort(),
    );
  });

  it("returns [] when none of the findings are in changed files", () => {
    const changedFiles = new Set(["docs/CHANGELOG.md"]);
    assert.deepEqual(selectNewOffenders({ files, issues, changedFiles }), []);
  });

  it("flags an unused file when the branch added/changed that file", () => {
    const changedFiles = new Set(["tests/scripts/smoke-walk.ts"]);
    const offenders = selectNewOffenders({ files, issues, changedFiles });
    assert.deepEqual(offenders, ["unused file: tests/scripts/smoke-walk.ts"]);
  });

  it("flags a devDependency only when its package.json was changed by the branch", () => {
    const changedFiles = new Set(["server/package.json"]);
    const offenders = selectNewOffenders({ files, issues, changedFiles });
    assert.deepEqual(offenders, ["devDependencies: server/package.json: yaml"]);
  });

  it("accepts a plain array for changedFiles, not just a Set", () => {
    const offenders = selectNewOffenders({
      files: [],
      issues: [{ file: "a.ts", exports: ["foo"] }],
      changedFiles: ["a.ts"],
    });
    assert.deepEqual(offenders, ["exports: a.ts: foo"]);
  });

  it("handles knip item objects ({name}) as well as bare strings", () => {
    const offenders = selectNewOffenders({
      files: [],
      issues: [{ file: "a.ts", exports: [{ name: "foo" }] }],
      changedFiles: new Set(["a.ts"]),
    });
    assert.deepEqual(offenders, ["exports: a.ts: foo"]);
  });
});
