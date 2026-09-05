// #2538 — the resolver's own rules, plus the pins that stop the copies of
// these numbers that CANNOT import it from drifting away.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEV_PORT_BLOCK_BASE,
  DEV_PORT_BLOCK_SPAN,
  DEV_PORT_OFFSETS,
  DEV_PORT_SERVICES,
  resolveDevPorts,
  devUrl,
} from "./dev-ports.mjs";

const repoPath = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const repoFile = (rel) => readFileSync(repoPath(rel), "utf8");

/** Every file under `dir`, recursively. */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(full) : [full];
  });
}

describe("resolveDevPorts", () => {
  test("lane 0 is the documented block", () => {
    assert.deepEqual(resolveDevPorts(), {
      client: 10900,
      server: 10901,
      qaClient: 10902,
      qaServer: 10903,
      minioApi: 10910,
      minioConsole: 10911,
      www: 10920,
      brochure: 10921,
      brochureServer: 10922,
      brochureClient: 10923,
    });
  });

  test("every service has a distinct port", () => {
    const ports = Object.values(resolveDevPorts());
    assert.equal(new Set(ports).size, ports.length);
  });

  test("lanes are disjoint — the property #2403 will depend on", () => {
    // The whole point of a span: no port from lane N may appear in lane N+1.
    // If an offset ever grew past the span this fails here rather than as two
    // worktrees quietly sharing a server.
    const seen = new Set();
    for (let lane = 0; lane < 8; lane++) {
      for (const port of Object.values(resolveDevPorts({ laneOffset: lane }))) {
        assert.equal(seen.has(port), false, `port ${port} reused by lane ${lane}`);
        seen.add(port);
      }
    }
  });

  test("a lane offsets the whole block by the span", () => {
    const lane2 = resolveDevPorts({ laneOffset: 2 });
    for (const service of DEV_PORT_SERVICES) {
      assert.equal(
        lane2[service],
        DEV_PORT_BLOCK_BASE + 2 * DEV_PORT_BLOCK_SPAN + DEV_PORT_OFFSETS[service],
      );
    }
  });

  test("an override wins, and only for the service it names", () => {
    const ports = resolveDevPorts({ overrides: { qaServer: 3001 } });
    assert.equal(ports.qaServer, 3001);
    assert.equal(ports.qaClient, 10902);
  });

  test("an empty override means 'not set', not port zero", () => {
    // A shell that exports QA_SERVER_PORT="" is saying nothing, not asking for
    // an invalid port — and falling through beats a confusing numeric error.
    assert.equal(resolveDevPorts({ overrides: { qaServer: "  " } }).qaServer, 10903);
  });

  test("a typo'd override is rejected rather than silently ignored", () => {
    assert.throws(() => resolveDevPorts({ overrides: { qaserver: 3001 } }), /unknown service/);
  });

  test("an unusable port is refused, naming where it came from", () => {
    assert.throws(() => resolveDevPorts({ overrides: { client: 80 } }), /the 'client' override/);
    assert.throws(() => resolveDevPorts({ overrides: { client: "nope" } }), /not an integer/);
    assert.throws(() => resolveDevPorts({ laneOffset: -1 }), /non-negative integer/);
    assert.throws(() => resolveDevPorts({ laneOffset: 1e6 }), /outside \[1024, 65535\]/);
  });

  test("devUrl spells the origin once, with no trailing slash", () => {
    assert.equal(devUrl(10900), "http://localhost:10900");
  });

  test("brochure lane ports sit beside the static brochure port and clear every other service", () => {
    const p = resolveDevPorts();
    assert.equal(p.brochureServer, p.brochure + 1);
    assert.equal(p.brochureClient, p.brochure + 2);
    const all = Object.values(p);
    assert.equal(new Set(all).size, all.length);
  });
});

// ── The pins ────────────────────────────────────────────────────────────────
// Three consumers cannot import the resolver: server/src (tsconfig rootDir is
// `src`, so an import from ../../scripts breaks `npm run build`), and the two
// declarative files (docker-compose.yml, .env.example) that have no import
// mechanism at all. Each therefore repeats a number, exactly once, and this is
// what makes the repetition safe.
describe("pins — the copies that cannot import the resolver", () => {
  const PORTS = resolveDevPorts();

  test("server/src/config/devPorts.ts matches the resolver", () => {
    const src = repoFile("server/src/config/devPorts.ts");
    assert.match(src, new RegExp(`DEV_DEFAULT_CLIENT_URL = "${devUrl(PORTS.client)}"`));
    assert.match(src, new RegExp(`DEV_DEFAULT_SERVER_PORT = ${PORTS.server}\\b`));
    assert.match(src, new RegExp(`DEV_DEFAULT_MINIO_ENDPOINT = "${devUrl(PORTS.minioApi)}"`));
  });

  test("the client-URL default appears exactly once in ALL of server/src", () => {
    // #2538's `(single-default)` criterion. 20 copies across 9 files is what
    // made the last move a 20-site hunt in which a miss failed as a runtime
    // CORS rejection rather than as anything visible.
    //
    // This MUST walk the whole tree. An earlier version read only
    // config/devPorts.ts and counted within that one file, so it asserted
    // "devPorts.ts defines it once" while its name promised "server/src has it
    // once" — someone re-adding the literal in routes/auth.ts would have passed
    // green, and the guard is the durable half of this change.
    const hits = walk(repoPath("server/src"))
      .filter((f) => /\.tsx?$/.test(f))
      .flatMap((f) => {
        const n = readFileSync(f, "utf8").split(`"${devUrl(PORTS.client)}"`).length - 1;
        return n > 0 ? [`${f}:${n}`] : [];
      });
    assert.deepEqual(
      hits.map((h) => h.replace(/^.*\/server\/src\//, "server/src/")),
      ["server/src/config/devPorts.ts:1"],
    );
  });

  test("docker-compose maps MinIO onto the block's host ports", () => {
    const compose = repoFile("docker-compose.yml");
    assert.match(compose, new RegExp(`"${PORTS.minioApi}:9000"`));
    assert.match(compose, new RegExp(`"${PORTS.minioConsole}:9001"`));
    // In-container ports are NOT ours to move; only the host side changed.
    assert.match(compose, /--console-address ":9001"/);
  });

  test(".env.example carries the block's values", () => {
    const env = repoFile(".env.example");
    assert.match(env, new RegExp(`^CLIENT_URL=${devUrl(PORTS.client)}$`, "m"));
    assert.match(env, new RegExp(`^MINIO_ENDPOINT=${devUrl(PORTS.minioApi)}$`, "m"));
    assert.match(
      env,
      new RegExp(`^MINIO_BROWSER_REDIRECT_URL=${devUrl(PORTS.minioConsole)}$`, "m"),
    );
    assert.match(env, new RegExp(`^MINIO_PUBLIC_BASE_URL=${devUrl(PORTS.minioApi)}/`, "m"));
  });
});

// ── The regression this whole change exists downstream of ───────────────────
describe("CI must state its Vite port, never inherit it", () => {
  // Before #2538, four workflows started Vite with no --port and then polled a
  // hardcoded :5173. The port was therefore supplied BY OMISSION from
  // client/vite.config.ts, so CI silently tracked whatever local dev used and
  // moving the dev default would have reddened the per-PR gate with "Vite
  // preview server never became ready". CI's numbers are deliberately
  // unchanged; what changed is that they are now written down. This guard
  // stops the coupling being reintroduced by the next person to add a step.
  // Every workflow, not a hardcoded list — a fifth file that launches Vite must
  // be guarded the moment it is added, not the moment someone remembers to add
  // it here.
  const WORKFLOW_DIR = repoPath(".forgejo/workflows");
  const WORKFLOWS = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));

  // A line that starts Vite. `npm run <script>` is listed separately because it
  // needs a DIFFERENT flag form (see below).
  const VITE_DIRECT = /(?:bin\/)?vite\s+(?:preview|dev)\b/;
  const VITE_VIA_NPM = /npm\s+run\s+(?:dev|preview)\b/;

  test("every workflow that launches Vite states its port", () => {
    assert.ok(WORKFLOWS.length >= 4, "no workflows found — the guard would pass vacuously");
    const problems = [];
    for (const wf of WORKFLOWS) {
      const lines = readFileSync(`${WORKFLOW_DIR}/${wf}`, "utf8").split("\n");
      for (const line of lines) {
        if (line.trim().startsWith("#")) continue;
        const viaNpm = VITE_VIA_NPM.test(line);
        if (!viaNpm && !VITE_DIRECT.test(line)) continue;
        // `npm run dev --port 5173` is NOT the same command: npm swallows the
        // flag as its own and vite never sees it, so the process falls back to
        // the config default and the by-omission coupling is silently back.
        // Only the `--` passthrough reaches vite.
        const ok = viaNpm ? /--\s+--port\s+\d+/.test(line) : /--port\s+\d+/.test(line);
        if (!ok) problems.push(`${wf}: ${line.trim()}`);
      }
    }
    assert.deepEqual(
      problems,
      [],
      "these lines start Vite without an explicit port reaching vite, so CI would " +
        "inherit client/vite.config.ts's default:\n  " +
        problems.join("\n  "),
    );
  });
});
