# Implementing an Issue — verify the premise first

Four checks before writing code. Each is under five minutes, and each caught a real error on 2026-07-26 — a day when **three of four issues implemented turned out to be wrong about something**, and one would have shipped a regression if built as written.

The pattern behind them: **an issue's observation is usually right; its diagnosis often isn't.** Whoever filed it — an agent audit, a playtest, a person at the table — saw *behaviour*. They could not see *authorship*, so they had no way to tell a deliberate ruling from a bug.

This is not a claim that most issues are wrong. Most aren't. It's a claim that these four checks are cheap enough to run anyway.

## 1. Rules-shaped claim? Check RAW

Anything asserting how Shadowdark *should* behave gets checked against the rulebook before you accept it. Use the `/rules-lookup` skill, or `~/Downloads/Shadowdark_Player_Quickstart_-_Digital.pdf` — web paraphrases are unreliable.

**Read the exact wording.** It is frequently the ruling.

> **#1921** was filed `critical` as *"AoE resolved against allies"*, with the acceptance criterion *"filter to valid-faction targets."* Quickstart p59 says a Burning Hands blast damages *"**creatures** within the area of effect"* — not *enemies*. Friendly fire was authored deliberately (#1378/#944). **Implementing the stated acceptance would have been a regression.** One word carried the whole decision.

## 2. "Layout X only" / "subsystem Y" claim? Check it's actually scoped there

Before accepting a parity or subsystem framing, grep for where the component is actually mounted.

> **#1921** was filed as a War Table bug. `SpellShapeLayer` renders only from `MapTab.tsx`, which Classic and the War Table share — so it could not have been WT-specific, and the parity framing was wrong before any code was read.

## 3. Read the issue's own confound / caveat section

Good reporters flag what they couldn't rule out. That section frequently contains the entire explanation.

> **#1921**'s confound section said the monsters had no map tokens. That was the whole answer: an AoE resolves against tokens, so nothing else could have been hit.

## 4. Grep the issue number in code and changelog

It may already be fixed — by a sibling issue, a systemic fix, or a PR that closed it in passing.

> **#1851** was fixed by #1827, both halves: the repository-boundary normalize *and* the render guard. Three minutes to confirm, versus a full implementation cycle.

## When the checks say the issue is wrong

**Don't silently implement something different.** Say so, then deliver:

1. State what you found, with the citation (rule text, mount points, the closing commit).
2. Reframe the issue — strike the incorrect claims, keep the confirmed defect, revise the acceptance criteria. Preserve the original in a `<details>` block so the history stays auditable. Keep the revised list as the **single live `## Acceptance`** (a dated qualifier like `## Acceptance (revised 2026-08-10)` is fine): the reconciliation gate strips `<details>` and flags any second live `## Acceptance` header, so it follows the revised list, not the archived one (#2320). To withdraw one key that moved to another ticket, mark it `- [ ] (slug) … — superseded:#M` rather than striking it through.
3. Build the *real* fix.

A reframed issue is a better outcome than a wrongly-implemented one, and far better than an argument in a PR body about why the code doesn't match the ticket.

## The other half: your own implementation can be wrong too

The same day, **#1869**'s own test caught a defect in the fix for it — a ruleset hook throwing its own error escaped the handler entirely. Written after the fact, that test would have agreed with the bug.

So: **prove the test red before trusting it.** For a change that can't fail on a happy path, write the failure case first — the one that forces the error, the timeout, the rollback. That's the test that earns its place.

## Scope of this claim

The evidence is one day: four issues, one prevented regression, one `quick-win` correctly rescoped, one implementation cycle saved. Whether it generalises is worth revisiting after a few more. Tracked on **#1972**.

Related: **#1899** and **#1916** carry calibration notes for the two sources that produced most of these findings (a static parity audit and a gap-hunt playtest).
