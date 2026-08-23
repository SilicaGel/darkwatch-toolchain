---
name: rules-lookup
description: 'Use when any task needs the official Shadowdark rule for something — creature stats, item costs/slots, spell details, class/ancestry features, or mechanics like light sources, crawl rounds, rest, death, morale, XP, treasure/gold. Answers come from the local rulebook corpus with page citations. Examples: "what does a torch cost", "how does SD handle gold/coin weight", "RAW crawl round length".'
version: 1.0.0
last_changed: 2026-07-26
---

# Shadowdark Rules Lookup

Authoritative RAW source: the local corpus at `reference/shadowdark-core/`
(gitignored; built from the purchased core rulebook, V4-9, 332 pp). All `page`
fields and `(p. N)` cites are **PDF** page numbers; the book's printed footers
run 4 lower (printed N = PDF N+4).

**If the corpus is missing** (fresh machine/worktree): it is local-only by
design. Build it per `docs/plans/2026-07-26-rulebook-corpus-extraction.md`
(Phase 0 script: `scripts/extract-rulebook.sh`; Phase 1/1b need agent
extraction — ask Aaron before re-running those). Do NOT answer Shadowdark RAW
questions from model memory or the web; both are unreliable for this book —
flag the question for a human instead.

## Lookup method (in order)

1. **Structured data** — exact numbers live here. `structured/` files:
   `creatures.json` (239 stat blocks), `weapons.json`, `armor.json`,
   `gear.json` (costs + slots + item rules), `spells.json` (85 spells),
   `classes.json`, `ancestries.json`, `backgrounds-titles.json`,
   `magic-items.json` (97 items). Grep by name (names may be ALL-CAPS or
   Title Case — search case-insensitively), read the entry, note its `page`.
   Gear gotcha: item cost-table rows and prose descriptions live on adjacent
   pages (p. 39 table / p. 38 descriptions) — check both when page-verifying.
   Distance terms (close/near/far) are defined only in the inside-cover
   quick-ref (p. 3) — full text in `mechanics/movement-and-distance.md`.
2. **Mechanics prose** — rules and procedures. `mechanics/<topic>.md`, one
   topic per file (light-sources, time-and-crawl-rounds, combat-sequence,
   death-and-dying, rest-and-camping, morale, stats-and-checks, luck-tokens,
   spellcasting-and-focus, xp-and-leveling, treasure-and-gems,
   magic-item-attributes, encounters-and-distance, traps-and-hazards,
   movement-and-distance, overland-travel, downtime-carousing-hirelings,
   monsters-attributes-and-design, gm-guidance, the-basics,
   alignment-deities-languages). Every rule line carries a `(p. N)` cite.
   Not sure which topic? Check `INDEX.md` (chapter map).
3. **Ground truth** — before a looked-up value goes into a code change, an
   issue, or an answer delivered to a person, re-verify it against the raw
   page text: `pages/pNNN.txt` (zero-padded PDF page number from the entry's
   cite).

## Rules

- Always report the page number alongside the answer.
- Corpus values with a `_flags` field (or `> FLAG:` in mechanics files) are
  known-ambiguous — read `pages/pNNN.txt` yourself before using them.
- Never paste corpus passages into issues, PRs, or anything that leaves this
  machine — cite page numbers instead (licensing rule; see
  `docs/specs/2026-07-26-shadowdark-corpus-extraction-audit.md`).
- `audit-candidates.md` and `qa-report.md` are process artifacts, not rules —
  don't cite them as RAW.
- Multi-ruleset note: this skill currently serves Shadowdark only. When a
  second ruleset gets a corpus, layout becomes `reference/<ruleset>/` and this
  skill gains a ruleset parameter.
