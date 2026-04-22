---
name: restart-local-dev
description: Use when the user runs /restart-local-dev or asks to restart local Darkwatch dev servers. Kills all running Darkwatch processes (client, server, www, brochure) and restarts them fresh.
---

# Restart Local Dev

Kills all Darkwatch dev processes and restarts them clean.

## Servers

| Name | Command | URL |
|------|---------|-----|
| Client (Vite) + Server (Express) | `npm run dev` in project root | :5173 + :3000 |
| WWW | `npx serve www -p 4200` | :4200 |
| Brochure (Vite preview) | `npx vite preview --port 5199 --host 127.0.0.1` in `client/` | :5199 |

## Steps

1. Find and kill all Darkwatch processes:
   - `tsx watch src/index.ts` (main workspace only, not worktrees)
   - `vite` (main workspace)
   - `vite preview` (main workspace)
   - `serve www` on port 4200

2. Clear Vite cache: `rm -rf client/node_modules/.vite`

3. Restart each server in the background, logging to `/tmp/darkwatch-*.log`

4. Wait 3 seconds, then tail all logs to confirm startup

5. Report which URLs are live
