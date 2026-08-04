# Gap-hunt mode — exploratory, first-time-user playtesting

The aim is **gaps over bugs**: find what's *missing, unobvious, or below expectations*, which regression tests structurally can't. Drive the **real rendered UI** and reason **only from what a human would see** — never read source or DB to "know" a feature exists. If you can't find it on screen, that *is* the finding.

Use the same driver/harness as `SKILL.md` (custom-ports sandbox recommended for long runs). Read `gotchas.md` first. Play in a **fresh campaign created through the UI**; never reset the shared DB.

**The War Table is the default layout since #1670** — a first-time human lands in it, so run every persona and job there. Classic is the fallback a user reaches via a "Switch to Classic" control or `?layout=classic`; treat Classic-only findings as lower-priority unless the gap is that the *switch itself* is unfindable.

---

## How to run it

1. Pick the **personas** and **jobs** relevant to what the user asked for (default: all core personas + core jobs below).
2. For each job, adopt the persona's mindset and pursue the goal from the rendered UI. Screenshot each meaningful state and **Read the screenshot** — visual judgment is the point.
3. When you succeed, note how it *felt*. When you can't (or it's confusing/empty/clunky/below a competitor), log a gap with its **class**, the persona goal, what you **expected**, what you **found**, severity, and the screenshot path.
4. After the run, write the report and the proposed-issues list (see Output).

---

## Personas

- **First-time player** — handed a join link, no account, no idea how the app works. Can they get in, make a character, and play?
- **First-time DM** — created a campaign, now what? Invite players, build/run combat, set a scene. The connective onboarding tissue is where this persona bounces.
- **Mobile-only user** — phone in portrait. Is every core job doable with thumbs? (Use the `mob` session / 390×844.)
- **VTT power-user (ex-Roll20 / Owlbear / Foundry / D&D Beyond)** — brings concrete expectations. Best persona for **competitive gaps** ("why can't I do X here?").
- **Rules lawyer (ruleset-scoped)** — knows the campaign's ruleset RAW cold and flags mechanics that diverge. **This lens is keyed to the campaign's ruleset** (see Rules-correctness lens) so it can extend to future rulesets.

---

## Jobs to be done (core)

Pursue each as the relevant persona, acting only on what's visible:

1. **Join a game** — as a new player, get from an invite link to "I'm in the campaign." (Does the DM-side invite even exist / is it findable?)
2. **Add players** (DM) — how do I get my party in? Is the affordance visible? Is there feedback?
3. **Create / customize a character** — make one by hand and via "Roll Me Up"; pick an avatar; verify your choices before committing.
4. **Run first combat** (DM) — start a session, add monsters, start combat, **make a monster attack a player**, apply damage.
5. **Set a scene** — upload/choose a map, make it active, reveal it, move/measure/annotate tokens.
6. **Find help / rules** — as a confused newcomer, where do I learn how any of this works?
7. **Come back for session two** — resume the campaign: does the recap orient you? Can you rest, level up, spend the XP you earned, and pick up where you left off? (Retention lives or dies here, and first-run jobs structurally never reach it.)
8. **Bring in a latecomer mid-session** — a new player joins while the table is live: do they appear for everyone without reloads, land on the map, and get oriented?
9. **Wrap up a session** (DM) — end it, get the recap, export what you'd want to keep. Then: what would you prep for next week, and can you do that prep now, outside a live session?

For each: can a newcomer *discover* the path, *complete* it, and does it *feel* right?

---

## Gap classes

Tag every finding with one (overlaps are fine — pick the primary):

1. **Dead end / unobvious affordance** — the path doesn't exist or isn't discoverable from the screen ("how do I add a player / make a monster attack?").
2. **Missing content / blank state** — a surfaced feature with nothing behind it, or an empty state with no guidance. (But see Env-caveats — unseeded *dev* data is not a product gap.)
3. **Competitive gap** — a capability VTT users expect from Roll20/Owlbear/Foundry/D&D Beyond that's absent (see Competitive matrix).
4. **Awkward / feel** — it works but is clunky, cramped, slow, or confusing to a newcomer. Includes the **responsive × role sweep** (below).
5. **Accessibility** — keyboard navigability (tab order, focus traps, can you operate it without a mouse?), visible focus states, color-contrast that looks AA-risky, missing alt text / labels / aria on key controls, tap-target size on mobile, motion with no reduce-motion respect. Flag what a screen-reader or keyboard-only user would hit.

Praise is information too — record what felt clear/good; it tells the team what not to break.

---

## Responsive × role sweep

After the core jobs, screenshot the core screens (dashboard, character sheet, session/combat view, map view) for **both DM and player** at:

- **Mobile portrait** 390×844 — set with `page.setViewportSize`.
- **Laptop** 1366×768.
- **Native 4K** 3840×2160 — watch for wasted whitespace / fixed-width corner band / tiny non-scaling map / horizontal scroll.

If time is short, prioritize the **extremes** (mobile + 4K). Log layout problems as **awkward/feel** (or **accessibility** for tap-target/contrast issues).

---

## Systematic sweeps (find the gaps nobody thought to look for)

Personas and jobs find gaps on the paths you *chose to walk*. These sweeps are enumerative — they walk paths chosen by the app's own surface area, which is where the unimagined gaps live:

- **Help-vs-reality:** read the in-app help page end to end and verify every control, button, and flow it promises actually exists on screen — and the reverse: pick the 5 most prominent controls you used today and check help mentions them. (Real catch of this class: help described a GM Tools button after the panel was removed — #2135.)
- **Empty-state census:** visit every screen/panel/tab you can reach with **zero data behind it** (new account, no campaigns, no characters, empty log, no maps, empty loot, no sessions). Each empty state either guides ("add your first…") or is a dead wall — log the walls. (Mind the env-caveats guard below: unseeded *dev galleries* are environment, not product.)
- **Interruption & recovery:** mid-flow reload (character wizard step 3, combat setup half-filled, map upload in flight), browser back button, an expired/re-used invite link, a session that ends while a player is mid-roll. Does state survive, and does whatever was lost *say* it was lost?
- **Settings census:** open every settings surface (account, campaign, per-panel ⚙) and for each option ask: would a user know what it does from its label alone, and does changing it visibly do that? An option nobody can decode is a gap even when it works.

Time-box the sweeps (they're enumerative, they can eat a run); a partial sweep with its cut-line documented beats skipping the category.

---

## Rules-correctness lens (ruleset-scoped)

Determine the **campaign's ruleset** first (today the only ruleset is **Shadowdark**; structure findings so other rulesets can plug in their own checklist later — tag rules findings with the ruleset). Apply the matching checklist; a divergence from RAW is a finding (class: dead-end if the option is missing, awkward/feel or a bug if the math is wrong).

### Shadowdark checklist (RAW)

**The oracle is the `rules-lookup` skill** — the local rulebook corpus with page citations. Answer every RAW question through it and cite the page in the finding; never assert RAW from memory or a web paraphrase (web paraphrases have been wrong before). shadowdarklings.net remains a useful *second* opinion for generator output, not the source of truth.

> **Before asserting a "known divergence," check the issue's current state** (open/closed) — a cited issue may be fixed, in which case the checklist must verify the *corrected* behavior, not re-report the old bug.

- **Starting gold** = `2d6 × 5` gp (10–60, avg 35). *(#1456 — fixed; the log label prints the real dice since #1923. Verify the corrected behavior.)*
- **Prices & gear slots** — spot-check shop prices and slot costs against the corpus cost table. *(#1707 fixed six prices and #1955 made slots quantity-aware; a pinning test guards the catalog — the lens verifies the UI end.)*
- **Stat rolling** = `3d6` in order is RAW; the app also offers 3d6-assign / 4d6-drop / standard array — the **campaign's chosen method should be honored** by character creation. *(#1467 — check state.)*
- **Ancestries** (core): Human, Elf, Dwarf, Halfling, Half-Orc, Goblin. **Classes** (core): Fighter, Priest, Thief, Wizard.
- **HP** = roll class hit die + CON mod at level 1 (min 1).
- **Crawling Kit** affordance for low-gold characters; carry limit = max(STR, 10).
- **Light/torch** economy, deity/alignment, backgrounds present and sensible.
- **Crit semantics**: only an attack roll's natural 20 is a *critical hit*; a nat 20 on a check or save just succeeds maximally *(#2049 — the app now draws this distinction; verify it holds where you roll)*.

> Other rulesets (OSE, etc.): add a sibling checklist here when the ruleset ships; key the lens off the campaign's ruleset slug so the right RAW applies.

---

## Competitive matrix (score the app against these)

For each, note **present / partial / absent** and whether its absence would surprise a VTT user:

- **Map/scene:** measure/ruler, ping, token labels/nameplates, fog-of-war + reveal, drawing/annotation (pen/line/arrow/text), token select→context menu, grid controls, decorative props.
- **Characters:** portrait/avatar (incl. AI generation), sheet depth, import/export, level-up flow.
- **Session:** invite flow that names the campaign/DM, handouts, dice (shared/3D), initiative/combat tracker, chat/log.
- **Onboarding:** first-run tour, empty-state guidance, in-app help/rules reference.
- **Platform:** mobile parity, large-screen scaling, keyboard/a11y.

A "partial/absent" that competitors all have → a **competitive gap** finding.

---

## Discipline guards (read before filing anything)

- **Env-caveats are NOT product gaps.** A local/sandbox dev DB may be unseeded (e.g. **no avatar/portrait/bestiary images** — only maps). Empty galleries there are an *environment* gap, not a product gap. Evaluate the *UX/affordance* of the empty state, note the data absence **once** as a caveat, and defer content-completeness to a **prod** check.
- **Verify before filing a suspected bug.** Reproduce the smallest path and check **server vs client** before asserting a root cause. (Lesson from the 2026-06-28 run: a "403 Image is not yours" looked like a server ownership bug, but a clean API repro returned 201 — the real cause was the client sending a stale image_id. Filing the server theory would have been wrong.)
- **A code read is not a verification.** Reading source can tell you a mechanism is *absent*; it cannot tell you the *user-visible consequence*. On 2026-08-03 "this stylesheet has zero `--wt-*` tokens" was filed as "the themes don't reach this panel" (#2169) — true premise, wrong conclusion, because the panel styles from semantic tokens the themes redefine. One screenshot under each theme settled it. **If the finding is about what the user sees, the evidence must be something the user could see.**
- **Check RAW before filing a rules bug — system intuition lies.** On 2026-08-04 a STR −2 character showed `1d4` club damage with no modifier, which reads as an obvious missing-modifier bug in D&D terms. Shadowdark (p. 93) adds *no* ability modifier to damage; the app was correct. Route it through `rules-lookup` and cite the page **before** writing the issue, not after someone questions it.
- **Report-only by default.** Do not auto-file. Present the proposed-issues list and let the user file via `/issue` after review (especially for unattended/background runs).

---

## Output

Write `docs/playtests/YYYY-MM-DD-gap-hunt-report.md`:

- **Header:** type (gap-hunt #1455), persona set, build, sandbox ports, driver.
- **Method** + an **Environment caveats** block (what was unseeded / deferred).
- **Verdict up front** — the handful of things that matter most.
- **Gaps grouped by class** — each with: title, persona goal, expected, found, severity, evidence (screenshot path). Include the **rules-correctness** and **responsive × role** findings.
- **Character-generator quality** subsection when creation was exercised.
- **What felt good** (praise is information).
- **How it feels to a newcomer** — the narrative read.
- **Regression diff vs previous gap-hunt** — read the most recent `docs/playtests/*-gap-hunt-report.md` and mark each prior gap **fixed / still-present / regressed** before listing new findings (parity with regression mode).
- **Proposed issues (DO NOT FILE)** — numbered, each with: title · gap-class · one-line · **suggested epic milestone + phase** (route genuinely-unclassified ones to **Triage**). On filing, dedup against existing issues and fold evidence into them rather than creating duplicates.
