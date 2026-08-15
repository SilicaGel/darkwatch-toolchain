---
name: update-help
description: Use when a user-facing feature is added, changed, or removed — keeps the in-app help page (client/src/pages/help/) in sync with the app. Skip for backend-only changes.
version: 1.1.0
last_changed: 2026-08-14
---

# update-help

Keeps the in-app `/help` page current. The page is built from
`client/src/pages/help/helpToc.ts` (section index) + one TSX component per
section in `client/src/pages/help/sections/`. `HelpPage.test.tsx` enforces
TOC ↔ section integrity, so edits that touch `helpToc.ts` must keep both
sides consistent (the test will catch drift — run it).

## Help-page purpose

User-facing, in-app, "how do I do X right now" reference. Tone: practical
and brief — "to do X, click Y", real UI labels in `<strong>`, keys in
`<kbd>`. Text-only (no screenshots — deliberate, see the #773 spec).
HANDBOOK.md stays the deep-dive; the brochure stays marketing. All content
is visible to every role by design.

## Step 0: Audit what changed (ALWAYS run first, cheap, decides skip-vs-act)

```bash
# Every client path touched in this branch
git diff main...HEAD --stat -- client/

# What this branch's new changelog fragment(s) say — title + body only.
# Frontmatter's `issues:`/`bump:` lines are YAML, not prose, so they're
# dropped; only `title:` (re-labelled) and everything after the second `---`
# are printed (#2364 — fragments replaced a direct docs/CHANGELOG.md diff).
for f in $(git diff main...HEAD --name-only --diff-filter=A -- docs/changelog.d/); do
  echo "=== $f ==="
  awk '/^title:/{sub(/^title:[ \t]*/,""); print "Title: " $0; next}
       /^---$/{n++; next} n>=2{print}' "$f"
done | head -40
```

Backend-only diff (nothing under `client/src/` except tests/plumbing) →
**SKIP**: report the skip to the caller (typically `/ship`) and exit.

## Dispatch table — changed paths → help sections

Section ids live in `client/src/pages/help/helpToc.ts`. Map what changed:

| If you see changes in... | Section id(s) to review |
|---|---|
| `LoginPage*` / `RegisterPage*` / `JoinPage*` / invite flow | `getting-started` |
| `CharacterCard*` / `CompactCard*` / `CharacterSheet*` / creation wizard | `character-sheet` |
| Dice / roll components, ADV-DIS pills, roll log | `rolling`, `shortcuts` |
| `SpellList*` / spell casting / exhaustion | `spells`, `mech-spellcasting` |
| `GearList*` / `ItemPicker*` / loot pool | `gear-inventory` |
| `Condition*` | `conditions` |
| `DeathTimer*` / `StabilizeButton*` / `DyingControls*` | `death-and-dying`, `mech-death` |
| `LevelUp*` / spells-known | `level-up` |
| `MapTab*` / `MapCanvas*` / token layer (player-visible) | `map-basics` |
| `MapToolbar*` / walls / fog / UVTT / grid / pointer / AoE | `dm-maps` |
| Light sources / torches / `LightSourceEditor*` | `dm-lights`, `mech-light` |
| `ThemeToggle*` / themes / `SettingsPage*` / 2FA | `settings-and-themes` |
| `MobilePlayerTabBar*` / `CampaignMobileMenu*` / PWA manifest | `mobile-play` |
| `CampaignWizard*` / `CampaignSettingsPage*` / invites (DM side) | `dm-campaigns` |
| Session start/end / `SessionTimer*` / presence | `dm-sessions` |
| Initiative / monster tracker / `CombatBanner*` / morale | `dm-combat` |
| NPC companions | `dm-npcs` |
| `AtmospherePanel*` / ambient effects | `dm-atmosphere` |
| Handouts | `dm-handouts` |
| Session log / DM notes / AI recap | `dm-log-recap` |
| Control overrides / character transfer / delegated control | `dm-delegation` |
| Luck tokens | `mech-luck` |
| Keyboard / modifier-key handling | `shortcuts` |
| `Nav*` / global chrome | `getting-started`, plus check the Help entry points still exist |

**Unmapped client changes** usually mean a **new feature** → Feature added.

## Processes

**Feature added** — new subsection inside the best-matching existing section,
or (for a genuinely new surface) a new section: add a `sections/` component,
an entry in `helpToc.ts` (id = kebab-case, stable forever), and a smoke
assertion in `HelpPage.test.tsx`. Verify every claim against the component
code — never invent labels.

**Feature changed** — update the section copy; re-verify quoted labels
against the diff. Update the smoke assertion if the load-bearing phrase moved.

**Feature removed** — delete the coverage: prose, or the whole section
(component file + `helpToc.ts` entry + its smoke assertion). Never leave help
for a feature that no longer exists.

After any edit:
`cd client && npx vitest run src/pages/help/HelpPage.test.tsx && npm run build`

## --full-audit

Walk `docs/feature-inventory.md` section by section (skip `## Admin …` and
plumbing rows — bcrypt rehash, `GET /auth/me`, API-envelope rows). For each
user-actionable row, name the help section that covers it. Output a
coverage table: `inventory section → rows uncovered → proposed help
section`. This is **skill-guided** — the output is a plan for a human/agent
to act on, not a CI gate (decision 2026-07-10, #773 spec).

## Commit

When invoked by `/ship`, skip the commit — ship owns the coordinated commit.
Standalone: commit as `docs(#NNN): update help page — <sections>`.
