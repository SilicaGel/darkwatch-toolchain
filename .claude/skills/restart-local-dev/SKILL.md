---
name: restart-local-dev
description: Use when the user runs /restart-local-dev or asks to restart local Darkwatch dev servers. Kills all running Darkwatch processes (client, server, www, brochure) and restarts them fresh.
version: 1.0.0
last_changed: 2026-07-05
---

# Restart Local Dev

Kills all Darkwatch dev processes and restarts them clean.

## Servers

| Name | Command | URL |
|------|---------|-----|
| Client (Vite) + Server (Express) | `npm run dev` in project root | :10900 + :10901 |
| WWW | `npx serve www -p 10920` | :10920 |
| Brochure (static site) | `npx serve . -p 10921` in `site/` | :10921 |

Ports come from the 10900 block (#2538) and are derived by `scripts/dev-ports.mjs` —
`node scripts/dev-ports.mjs` prints the whole set, `node scripts/dev-ports.mjs client`
prints one. Prefer the command over retyping a number. Vite now runs with
`strictPort`, so a busy port is a startup error naming the port rather than a silent
move to the next one.

## Steps

1. **Ensure env files are in place** (#859): run `scripts/worktree-init.sh`
   from the target checkout. It's a no-op on the main workspace and on any
   worktree whose env symlinks already exist; it only acts when a fresh
   worktree is missing `.env` or `server/.env`. Skipping this step in a
   fresh worktree leads to `docker compose` restart loops and "Bind
   parameters must not contain undefined" failures later.

2. Find and kill all Darkwatch processes:
   - `tsx watch src/index.ts` (main workspace only, not worktrees)
   - `vite` (main workspace)
   - `vite preview` (main workspace)
   - `serve www` on port 10920
   - `serve` on port 10921 (brochure)

3. Clear Vite cache: `rm -rf client/node_modules/.vite`

4. Restart each server in the background, logging to `/tmp/darkwatch-*.log`

5. Wait 3 seconds, then tail all logs to confirm startup

6. Report which URLs are live
