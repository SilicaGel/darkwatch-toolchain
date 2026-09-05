#!/usr/bin/env node
// #2538 — resolve the ports LOCAL DEV binds.
//
// Why this exists: `5173` and `3000` are two of the most contested ports on a
// developer machine. Any other Vite app, a stray node service, or bqq-lite
// takes one and the collision is not loud — Vite's default is to fall FORWARD
// to the next free port, so the browser lands on 5174 while the server's
// CORS/CSRF allowlist still says 5173, and auth failures look like an app bug.
// The database dodged this years ago by moving to 3397; the app ports never
// did. This module moves them into 10900–10921, a block nothing standard
// claims (Webmin is 10000, kubelet 10250) and well below the macOS ephemeral
// range (49152+).
//
// The second reason is the one that matters more. Before this, the fallback
// was a LITERAL, copy-pasted to 20 places across 9 files in server/src alone,
// and a missed copy does not fail loudly — it fails as a CORS rejection at
// runtime. One resolver means the next move is a one-line change, and it means
// bash, Vite, the test lanes and the server are incapable of disagreeing.
//
// ── PURITY IS LOAD-BEARING ───────────────────────────────────────────────────
// Every input is injected; this module never reads process.env, process.cwd()
// or the filesystem. That is not stylistic — it is the same rule, for the same
// reason, as server/scripts/int-db-name.mjs (#2062).
//
// Ports cannot be configured in `.env`. scripts/worktree-init.sh SYMLINKS
// `.env` and `server/.env` to the main checkout by #859 design ("changes to
// main's .env propagate to every worktree immediately. Zero drift risk"), so
// every worktree shares one copy and a per-lane port placed there is global by
// construction. #2403 therefore has to DERIVE a lane at runtime rather than
// configure one. A convenience `process.env.X ?? derive()` reached for inside
// this module would quietly re-share the value the derivation exists to split,
// and every test would still pass — the same invisible failure #1984's
// pre-dotenv ordering exists to prevent. Injected inputs also make the whole
// thing unit-testable without cwd games or env mutation.
//
// The CLI entry point at the bottom is the ONLY place ambient state is read.

import path from "node:path";
import { fileURLToPath } from "node:url";

/** Base of the block. `client` and `server` are adjacent so one number anchors
 *  the whole set. */
export const DEV_PORT_BLOCK_BASE = 10900;

/** Ports one lane reserves. #2403 strides by this to give each worktree its
 *  own block (lane 1 = 10932…, lane 2 = 10964…) rather than inventing a second
 *  numbering scheme. Every offset below MUST be < this — see the invariant
 *  check under DEV_PORT_OFFSETS, which is what makes two lanes structurally
 *  incapable of landing on the same port. That check is the port-side analogue
 *  of int-db-name.mjs's identifier-length ceiling: there, truncation is how two
 *  long worktree names silently become one database; here, an offset that
 *  overflowed the span is how two lanes would silently become one stack. */
export const DEV_PORT_BLOCK_SPAN = 32;

/** Offset within a lane's block, by service. The gaps are deliberate and
 *  documented on #2538: 1090x app lanes, 1091x storage, 1092x static sites. */
export const DEV_PORT_OFFSETS = Object.freeze({
  /** Vite dev/preview server — the app you open in a browser. */
  client: 0,
  /** Express app server. */
  server: 1,
  /** `scripts/qa-stack.sh`'s isolated Vite (#2008). */
  qaClient: 2,
  /** `scripts/qa-stack.sh`'s isolated app server (#2008). */
  qaServer: 3,
  /** MinIO S3 API — the HOST-side mapping only; in-container stays 9000. */
  minioApi: 10,
  /** MinIO web console — host-side only; in-container stays 9001. */
  minioConsole: 11,
  /** `npx serve www`. */
  www: 20,
  /** `npx serve site/` — the brochure/screenshot stack. */
  brochure: 21,
  /** `scripts/qa-stack.sh` server for the brochure capture lane (#2128). */
  brochureServer: 22,
  /** `scripts/qa-stack.sh` Vite for the brochure capture lane (#2128). */
  brochureClient: 23,
});

export const DEV_PORT_SERVICES = Object.freeze(Object.keys(DEV_PORT_OFFSETS));

// The invariant that makes lanes disjoint. Asserted at import rather than left
// to a test, because a future service added at offset 32+ would otherwise
// collide with lane N+1's `client` and the symptom would be two worktrees
// sharing a stack — exactly the bug this block exists to remove.
for (const [service, offset] of Object.entries(DEV_PORT_OFFSETS)) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= DEV_PORT_BLOCK_SPAN) {
    throw new Error(
      `[dev-ports] offset for '${service}' is ${offset}; it must be an integer in ` +
        `[0, ${DEV_PORT_BLOCK_SPAN}). An offset at or past the span would land on the NEXT ` +
        `lane's block, so two worktrees would share a port. Raise DEV_PORT_BLOCK_SPAN (and ` +
        `re-check the block has room) rather than reusing a number.`,
    );
  }
}

/** Below 1024 needs root on macOS/Linux; 65535 is the ceiling. */
const MIN_PORT = 1024;
const MAX_PORT = 65535;

/** Treat empty/whitespace-only as "not set". A shell that exports
 *  QA_SERVER_PORT="" means "no override", not "port zero" — and an empty
 *  string would fail the numeric check below with a confusing message instead
 *  of falling through to derivation. Same rule as int-db-name.mjs. */
function presentOrNull(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

/** Validate a final port. Reports the ORIGIN so a failure points at the thing
 *  to change (the override, or the lane) rather than at this file. */
function assertUsablePort(value, origin) {
  const port = Number(value);
  if (!Number.isInteger(port)) {
    throw new Error(`[dev-ports] '${value}' (from ${origin}) is not an integer port number.`);
  }
  if (port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `[dev-ports] port ${port} (from ${origin}) is outside [${MIN_PORT}, ${MAX_PORT}]. ` +
        `Ports below ${MIN_PORT} are privileged; above ${MAX_PORT} does not exist.`,
    );
  }
  return port;
}

/**
 * Resolve the whole block.
 *
 * Precedence, per service:
 *   1. An explicit override wins — this is how qa-stack.sh honours
 *      QA_SERVER_PORT / QA_CLIENT_PORT and how a one-off run can be pointed
 *      anywhere. Overrides are injected by the caller, never read here.
 *   2. Otherwise `DEV_PORT_BLOCK_BASE + laneOffset * DEV_PORT_BLOCK_SPAN + offset`.
 *
 * @param {object} [input]
 * @param {Record<string, string|number|null|undefined>} [input.overrides]
 *        per-service overrides, keyed by the names in DEV_PORT_OFFSETS.
 *        Unknown keys are rejected rather than ignored — a typo'd override
 *        that silently does nothing is how you spend an afternoon.
 * @param {number} [input.laneOffset]
 *        which lane's block to use. #2538 ships lane 0 for every caller; #2403
 *        derives this per worktree. It is a parameter now so that derivation
 *        lands in ONE place instead of at each of the callers this module
 *        already feeds.
 * @returns {{client:number, server:number, qaClient:number, qaServer:number,
 *            minioApi:number, minioConsole:number, www:number, brochure:number}}
 */
export function resolveDevPorts({ overrides = {}, laneOffset = 0 } = {}) {
  if (overrides === null || typeof overrides !== "object") {
    throw new Error("[dev-ports] overrides must be an object keyed by service name.");
  }
  for (const key of Object.keys(overrides)) {
    if (!(key in DEV_PORT_OFFSETS)) {
      throw new Error(
        `[dev-ports] unknown service '${key}' in overrides. Known services: ` +
          `${DEV_PORT_SERVICES.join(", ")}.`,
      );
    }
  }

  const lane = Number(laneOffset);
  if (!Number.isInteger(lane) || lane < 0) {
    throw new Error(`[dev-ports] laneOffset must be a non-negative integer (got: ${laneOffset}).`);
  }

  const laneBase = DEV_PORT_BLOCK_BASE + lane * DEV_PORT_BLOCK_SPAN;
  /** @type {Record<string, number>} */
  const ports = {};
  for (const [service, offset] of Object.entries(DEV_PORT_OFFSETS)) {
    const override = presentOrNull(overrides[service]);
    ports[service] = override
      ? assertUsablePort(override, `the '${service}' override`)
      : assertUsablePort(laneBase + offset, `lane ${lane}'s '${service}' slot`);
  }
  return /** @type {any} */ (ports);
}

/** `http://localhost:<port>` — the one place the scheme and host are spelled,
 *  so a caller building an allowlist entry and a caller building a curl target
 *  cannot disagree about a trailing slash. */
export function devUrl(port, { host = "localhost", protocol = "http" } = {}) {
  return `${protocol}://${host}:${assertUsablePort(port, "devUrl()")}`;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// `node scripts/dev-ports.mjs`            → `client=10900` … one per line
// `node scripts/dev-ports.mjs client`     → `10900`
// `node scripts/dev-ports.mjs --url client` → `http://localhost:10900`
// `node scripts/dev-ports.mjs --json`     → `{"client":10900,…}`
//
// This is how qa-stack.sh / qa-preflight.sh consume the rule instead of
// reimplementing it in bash — one source of truth, in a language that can be
// unit-tested. Same arrangement int-reset-db.sh has with int-db-name.mjs.
//
// The only place in this module that reads ambient state.
if (
  process.argv[1] &&
  // fileURLToPath, NOT `new URL(...).pathname` — the latter percent-encodes
  // (`/a/b c` becomes `/a/b%20c`) while process.argv[1] does not, so any
  // checkout path containing a space makes this comparison fail, the CLI block
  // never runs, and the command prints nothing while exiting 0. An exit-0 is
  // invisible to `set -e`, so the caller gets an empty port and fails much
  // later with a confusing message.
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  /** Env names the shell may use to override a service. Deliberately explicit:
   *  a derived `DEV_${SERVICE}_PORT` convention would silently accept
   *  DEV_QACLIENT_PORT and friends and leave the caller wondering. */
  const ENV_OVERRIDES = {
    client: "DEV_CLIENT_PORT",
    server: "DEV_SERVER_PORT",
    qaClient: "QA_CLIENT_PORT",
    qaServer: "QA_SERVER_PORT",
    minioApi: "MINIO_API_PORT",
    minioConsole: "MINIO_CONSOLE_PORT",
    www: "WWW_PORT",
    brochure: "BROCHURE_PORT",
    brochureServer: "BROCHURE_SERVER_PORT",
    brochureClient: "BROCHURE_CLIENT_PORT",
  };
  try {
    const overrides = {};
    for (const [service, envName] of Object.entries(ENV_OVERRIDES)) {
      if (presentOrNull(process.env[envName]) !== null) overrides[service] = process.env[envName];
    }
    const ports = resolveDevPorts({
      overrides,
      laneOffset: presentOrNull(process.env.DEV_PORT_LANE) ?? 0,
    });

    const args = process.argv.slice(2);
    if (args.includes("--json")) {
      process.stdout.write(JSON.stringify(ports) + "\n");
    } else if (args.includes("--url")) {
      const service = args[args.indexOf("--url") + 1];
      if (!service || !(service in ports)) {
        throw new Error(
          `[dev-ports] --url needs a service name (${DEV_PORT_SERVICES.join(", ")}).`,
        );
      }
      process.stdout.write(devUrl(ports[service]) + "\n");
    } else if (args.length > 0 && !args[0].startsWith("-")) {
      if (!(args[0] in ports)) {
        throw new Error(
          `[dev-ports] unknown service '${args[0]}'. Known: ${DEV_PORT_SERVICES.join(", ")}.`,
        );
      }
      process.stdout.write(String(ports[args[0]]) + "\n");
    } else {
      process.stdout.write(
        Object.entries(ports)
          .map(([service, port]) => `${service}=${port}`)
          .join("\n") + "\n",
      );
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
