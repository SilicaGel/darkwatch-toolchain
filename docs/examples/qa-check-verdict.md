# Example: a `/qa-check` verdict

Real output, from Darkwatch issue #2507 (2026-08-27), reproduced verbatim.

`/qa-check` takes issues sitting in a QA state and tries to disprove that they
are done. What to notice:

- **Every claim is keyed** to a named acceptance criterion agreed when the issue
  was filed (`(loot-type)`, `(transfer-fidelity)`, `(no-notes-squat)`), so the
  verdict cannot quietly answer an easier question than the one that was asked.
- **It records the surface it drove**, here the real Party Loot kebab and its
  "Give to" menu, rather than asserting through the API. Clicking the app is the
  point; an API call proves the backend works and the user's path does not.
- **It reports the observed values** (`type=weapon`, `slot_count=2`), not a pass.
- **It filed a blocker it found** rather than absorbing it: the follow-up became
  issue #2614.

---

Verified (qa-check) 2026-08-27 on main @ 52722c8c.

- **(loot-type)** A free-text loot entry accepts a declared `type` and `slot_count`; the fields are present in both loot panels.
- **(transfer-fidelity)** Driven through the real Party Loot kebab then "Give to" menu: the received gear row arrived **`type=weapon`, `slot_count=2`**, not a generic 1-slot gear row.
- **(no-notes-squat)** The received row's `notes` was `null`, with the name in its own field. Restacking is keyed on `custom_name` (not notes), proven by `loot-transfer.int.test.ts` "stacks custom items on repeated transfer, keyed on custom_name (#2507, was #564)", so editing a note cannot break restacking. That file ran green here against real MariaDB (32/32).

Spec: `tests/qa-check/2507/spec.ts`.

Note for a follow-up (filed separately): inside the War Table loot panel the catalog picker list visually overlaps the **Free-text** mode tab, so that tab could not be clicked at 1920x1200.

