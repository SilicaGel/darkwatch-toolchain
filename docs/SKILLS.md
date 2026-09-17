# The skills, in detail

Nineteen agent workflows. This page covers the five that carry the most design,
then summarizes the rest. Each one is a markdown file the agent loads on demand,
so the interesting content is the *rules*, not the code.

A note on shape: most of these are longer than they look necessary, because
almost every paragraph is there to close a specific hole that was found the hard
way. The issue numbers scattered through them (`#2364`, `#1963`) point at a
private tracker, but each anchors a real failure that explains the rule above it.

---

## `issue` — turn a sentence into a contract

Takes whatever was said, in a chat or through the app's feedback widget, and
files something specific enough to work from.

**It investigates before it writes.** Given "the help menu opens behind the
toolbar" it goes and reads the component, finds the rule responsible, and says so
in a "premise check" section. The issue that results names a likely cause and a
fix direction, so whoever picks it up is not starting from the complaint.

**It takes images.** Screenshots pasted into a chat are uploaded to the tracker
and embedded in the body. Reports from the in-app feedback widget arrive with the
message, the page URL, the browser and any attachments already gathered, and the
feedback row keeps a link to the issue it became.

**It checks for duplicates first**, against every open issue, title-first and
then title-plus-body, and proposes updating the existing one rather than filing a
near-twin.

**It ends with keyed acceptance criteria**, which is the part that matters most.
Each `(slug)` is a short stable key on one independently verifiable outcome,
phrased as something observable: a DOM state, a database row, a response code.
Never an implementation note. Those keys are the contract `ship` must answer and
`qa-check` must verify, so a criterion agreed at filing time cannot be dropped
later without somebody saying out loud that it was.

**It confirms before modifying anything that already exists**, because editing an
issue is harder to undo than creating one.

---

## `ship` — open the PR

Runs preflight, updates whichever docs the diff actually touched, commits them,
and opens the PR.

**Docs are updated by path check, not by ritual.** `ship` decides which of seven
doc-sync skills to invoke by looking at what the diff touched. The changelog
always; the handbook, onboarding, README, brochure and help only if their paths
are implicated. The roadmap is skipped by default and only runs on a genuine
strategic shift, because a roadmap that updates on every PR stops describing
direction and starts describing activity.

**The changelog is a fragment, never a direct edit.** Two PRs editing
`CHANGELOG.md` conflict every time. Each PR now drops a uniquely-named file into
`changelog.d/`, and a release collates them. Two fragments cannot conflict, so
there is nothing to hand-resolve.

An earlier attempt was rejected: a `merge=union` git driver would have made the
conflict disappear, but the changelog is a record, and a merge that always
succeeds removes the only signal that the result is wrong.

**`Ready #N`, never `Closes #N`.** The tracker auto-closes on `Closes`, which
means an issue would close on merge, before anyone confirmed the code does what
the issue asked. `Ready` moves it to a QA state instead. The agent can open the
PR; it cannot close the issue and it cannot merge.

See [a real PR body](examples/ship-pr-body.md).

---

## `qa-check` — try to disprove that it is done

Takes issues sitting in the QA state and verifies them in batches of three.

**"Wired is not works."** The default verification is driving the real UI in a
browser, not reading the code. Reading code proves the implementation exists;
only clicking the thing proves the user can reach it. The skill permits a
code-read in exactly two cases, and both have to be named out loud: the change
has no user surface at all (infra, migration, logging), or the behaviour is
already pinned by a falsifiable test that drives the real control and asserts the
real output. "A unit test exists" explicitly does not qualify.

**An obstructed surface is not the same as no surface.** When the agent
says "this can't be tested in a browser," it has to name the reason. If the
reason is a missing fixture, absent precondition state, or a dev server that is
down, then the surface is real and the obstacle gets cleared: seed the fixture,
start the session, restart the server, then drive it. Only an *inherent* absence
of UI earns the exemption. Without this rule, "hard to reach" quietly becomes
"verified by reading," which is how a broken feature ships.

**Every verdict is keyed to named acceptance criteria** agreed when the issue was
filed, so a verification cannot drift into answering an easier question than the
one that was asked. That check runs even when the PR's own test plan came back
green, because the plan describes what the shipper built rather than proving it
covered the ticket.

**When a human has to make the call, it hands over footage.** Animation, layout
and timing cannot be asserted. Rather than writing repro steps, it captures the
artifact: a video for motion, a contact sheet of stills for static layout, a
two-browser recording for anything where one player observes another. "Visual
only" means a person decides, not that nothing gets produced.

**It refuses to quietly take the cheap path.** Where a browser check would add
real signal, it proposes that check and waits for a yes or no rather than
settling for a code-read on its own initiative, and a declined check is recorded
as declined rather than presented as a pass.

**It assumes the tests might be lying.** For any mechanism fix the decisive
question is *could you make the shipped test go red by reverting the fix?* That
rule exists because an audit found five closed issues whose fix had never worked,
each closed on evidence that read the code without exercising the mechanism.

See [a real verdict](examples/qa-check-verdict.md).

---

## `queue-batches` — parallel agents that stay merge-clean

Dispatches several sub-agents, each working a handful of tickets in its own git
worktree.

**Exclusive file zones.** Tickets are grouped so that no two batches touch the
same area of the codebase. This is the whole trick: parallel branches that never
overlap are parallel branches that merge without conflict. Tickets in the same
zone run sequentially on one branch instead.

**Hard caps, chosen for context rather than compute.** Three batches maximum,
eight tickets per batch maximum. The limits exist because the orchestrator's
context and each sub-agent's context degrade past those points, not because the
machine runs out of capacity.

**No auto-push, no auto-merge.** Every batch hands back for review. Questions
from a sub-agent route back to the human, tagged with the batch that asked, which
means an agent that hits a genuine judgment call can stop and ask rather than
guessing confidently.

---

## `playtest` — three ways of being wrong

Drives the running app through real multi-client sessions with Playwright. A
long-running driver holds one browser with named sessions (`dm`, `p1`, `p2`,
`p3`, `mob`) open for the whole run and executes snippets posted to it, so state
survives between commands. It is a real table being played, not a sequence of
one-shot scripts.

The three modes exist because each finds a class the others structurally cannot:

- **Regression** drives a scripted set of acts and diffs against the previous
  report. Finds behaviour that *broke*.
- **Gap-hunt** drives as a naive first-time user who acts only on what is
  visually rendered, pursuing real goals. Finds what is *missing or unobvious*.
  A regression suite cannot find an absence, because you cannot write an
  assertion for a feature you have not thought of.
- **Adversarial** deliberately misuses one surface from a logged-in session:
  hostile socket emits, raw REST calls that bypass the client's own guards,
  concurrent races, stale state. Finds defects *outside the spec*. It is opt-in,
  bounded, and report-only, and it never gates a close.

---

## `deep-audit` — adversarial review of LLM-written code

A subagent-driven audit across security, performance, quality and operations,
reconciled against the open issue list so it does not re-report known problems.

Its opening premise is the honest one:

> The repo was almost entirely written by Claude with the author architecting;
> assume it has the failure modes of a code-LLM working without a strict
> reviewer: leaky abstractions, dead code, copy-paste duplication, half-baked
> error handling, optimistic happy-path assumptions, and security gaps that
> "look fine."

It confirms scope before spawning anything, and it **never files an issue on its
own**. It produces a report and the human decides what becomes a ticket.

---

## The rest

| Skill | What it does |
|---|---|
| `start` | Scope an issue, claim it, prepare the worktree, then **halt**. Implementation is a deliberately separate turn, so the decision to write code is made with a fresh context rather than carried in on momentum. |
| `issue` | File and triage tracker issues from conversation, with a duplicate check first and a confirmation step before modifying anything that already exists. |
| `review-pr` | Read a PR the way a reviewer would: does it do what it says, what did it not say, what would break. |
| `release` | Collate the accumulated changelog fragments into one versioned entry and open the release PR. |
| `back-to-main` | Tidy up after a merge: branch, worktree, local state. |
| `rules-lookup` | Answer domain-rules questions from a local corpus with page citations, and refuse to answer from model memory when the corpus is missing. The smallest complete example of the house style: ground the answer, cite the source, or escalate to a human. |
| `restart-local-dev` | Kill and restart the local stack cleanly. |
| 7 doc-sync skills | `update-changelog`, `update-readme`, `update-handbook`, `update-onboarding`, `update-help`, `update-roadmap`, `update-brochure`. Invoked by `ship` on a path check. |
