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
| Client (Vite) + Server (Express) | `npm run dev` in project root | :5173 + :3000 |
| WWW | `npx serve www -p 4200` | :4200 |
| Brochure (static site) | `npx serve . -p 5199` in `site/` | :5199 |

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
   - `serve www` on port 4200
   - `serve` on port 5199 (brochure)

3. Clear Vite cache: `rm -rf client/node_modules/.vite`

4. Restart each server in the background, logging to `/tmp/darkwatch-*.log`

5. Wait 3 seconds, then tail all logs to confirm startup

6. Report which URLs are live
