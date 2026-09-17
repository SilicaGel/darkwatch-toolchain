# Example: four words of player feedback becomes a diagnosed issue

Real output, from Darkwatch issue #2519 (2026-08-19), reproduced verbatim.

A player in a live game session opened the in-app feedback widget and typed, in
full:

> Make the quests seeable.

The widget captures the message, the URL, the browser, and any images, and the
row keeps a link to whatever issue it becomes. `/issue` was handed that, and it
produced what follows on its own.

**What it did with four words:**

- **Went and found the cause.** The "Premise check" section is not a restatement
  of the complaint. The skill opened `WtQuestsPanel.tsx` and its CSS module and
  identified the three declarations responsible: `overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap`.
- **Found the constraint behind the bug**, which the reporter never mentioned and
  probably did not know: the only way to read a quest's full text was to open the
  *edit* form, so reading required entering an editing surface.
- **Used the screenshots** from the session, quoting the actual truncated strings
  as evidence that it bit immediately.
- **Proposed a fix direction** without implementing it, and flagged that it has to
  work for read-only players, not just the DM.
- **Cross-referenced two related issues** after checking the open list for
  duplicates.
- **Wrote two keyed acceptance criteria**, both phrased as observable outcomes.
  Those `(full-text)` and `(player-read)` keys are the contract: `/ship` must
  later answer both, and `/qa-check` verifies both against the running app.

The reporter's handle is redacted below, and the screenshot URL points at private
storage so the scrub rewrote its host. Everything else is untouched.

---

Playtest feedback from the 2026-08-19 session (Black Wyrm of Brandonsford, v0.201.0). Reporter: **[player]** (player), feedback `01a0177a-3c6c-78ae-8a59-f3d37ce20022`:

> Make the quests seeable.

## Premise check (code)

Confirmed in `client/src/components/wt/WtQuestsPanel.tsx` + its module CSS: a quest card renders its description as a single `styles.notes` span whose CSS is `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` — one line, ellipsized. There is no expand affordance (`openQuestId` is only the "…" action-menu toggle). The **only** way to read a quest's full text today is to open the edit form — reading should not require entering an editing surface.

The screenshots from the session show it biting immediately: "Collect some Goblin legs after a battle to use with hot sauce on the B…", "dwarves are mining up north and havent sent any metal in last few w…" — every quest the table wrote was unreadable from the card.

## Fix direction

Let the card show the full description — expand on click/tap (accordion), or wrap to N lines with a "more" toggle. Should work for players (read-only viewers) as well as the DM.

Refs #2203, #2494.

## Screenshot

![truncated quest cards](<redacted: private storage>)

## Acceptance
- [ ] (full-text) A quest's complete description can be read from the Quests panel without opening the edit form
- [ ] (player-read) The same read affordance works in the player view, not just for the DM

