# Example: the diff-coverage bot

Real output, from Darkwatch PR #2608 (2026-08-27), trimmed to the first file.

Off-the-shelf coverage reporters give you one number for the whole repo, which
tells you nothing you can act on: the number moves when unrelated code changes,
and it never says which line to go write a test for.

This one reports coverage **of the lines this PR changed**, then prints them with
surrounding context so the uncovered ones are visible in place. The gutter marks
which suite covered each line: `U` unit, `I` integration, `UI` both. A line
covered only by integration tests is a different situation from one covered by
unit tests, and a single percentage hides that.

The split that makes it portable is in the code: `build-comment.mjs` reads the
coverage JSON and a `git diff` and prints markdown to stdout, with no network and
no tracker. `post-comment.mjs` is the only half that knows what a Forgejo is, and
it finds its own previous comment by a hidden sentinel so it edits in place
rather than posting a new wall of text on every push.

The screenshot below is the real comment as the forge renders it. GitHub's
markdown sanitizer strips the inline colours, so the verbatim source underneath
it shows the same thing without them: `+` marks a line this PR added, and `U` or
`I` in the gutter says which suite covered it.

![diff-coverage comment](coverage-comment.png)

---

<!-- coverage-bot:v1 -->
<!-- coverage-bot-meta: pct=92.9 threshold=60 covered=79 total=85 passed=1 -->
## 🧪 Coverage — this MR

🟢 **Diff coverage: 92.9%** — 79 of 85 new/changed lines covered

| Coverage type | Diff coverage |
|---|---:|
| Unit | 93% |
| Integration | — |
| Combined | 93% |

<sub>Gutter markers in snippets: `U` = unit only · `I` = integration only · `UI` = both</sub>
<sub>132 changed lines were non-executable (comments, types, blank).</sub>

<details open>
<summary><b>Uncovered lines</b> — 6 across 3 files</summary>

### `client/src/pages/wartable/WtWorkspace.tsx` — 8/11 (73%)

<sub>bright bar = new line covered/uncovered · muted bar = existing line · no bar = non-executable · <code>U</code>=unit <code>I</code>=int <code>UI</code>=both</sub>

<pre>
346            // whose `residents` actually contains `id` acts on it (and clears it) —
347            // see WtBand.tsx's own openRequest effect.
<span style="background-color:rgba(46,160,67,0.15)">348  <span style="color:#2ea043">+</span> <span style="background-color:#2ea043;color:#2ea043">|</span> U     const [bandOpenRequest, setBandOpenRequest] = useState&lt;{ id: WtPanelId; nonce: number } | null&gt;(</span>
<span style="background-color:rgba(46,160,67,0.15)">349  <span style="color:#2ea043">+</span> <span style="background-color:#2ea043;color:#2ea043">|</span> U       null,</span>
<span style="background-color:rgba(46,160,67,0.15)">350  <span style="color:#2ea043">+</span> <span style="background-color:#2ea043;color:#2ea043">|</span> U     );</span>
351            const { onGripDown, onFloatGripDown, dragId, ghost, preview, ghostRef, previewRef } =
352    <span style="background-color:rgba(46,160,67,0.40);color:rgba(46,160,67,0.40)">|</span>         useWtDragSession();
  ...
572    <span style="background-color:rgba(46,160,67,0.40);color:rgba(46,160,67,0.40)">|</span>             // #2005 — lets openCharFloat tell "band-pinned" apart from
573    <span style="background-color:rgba(46,160,67,0.40);color:rgba(46,160,67,0.40)">|</span>             // "docked"/"floated"; see WtLayoutValue's doc.
<span style="background-color:rgba(46,160,67,0.15)">574  <span style="color:#2ea043">+</span> <span style="background-color:#2ea043;color:#2ea043">|</span> U           isBandPinned: layout.isBandPinned,</span>
575    <span style="background-color:rgba(46,160,67,0.40);color:rgba(46,160,67,0.40)">|</span>             // #2005 — queues the "focus this pill" request both `&lt;WtBand&gt;`
576    <span style="background-color:rgba(46,160,67,0.40);color:rgba(46,160,67,0.40)">|</span>             // instances below are handed as `openRequest`; see that state's own
  ...
580    <span style="background-color:rgba(46,160,67,0.40);color:rgba(46,160,67,0.40)">|</span>             // queued) so a repeat request for the same id a band already
581    <span style="background-color:rgba(46,160,67,0.40);color:rgba(46,160,67,0.40)">|</span>             // acted on still re-triggers its effect.
<span style="background-color:rgba(46,160,67,0.15)">582  <span style="color:#2ea043">+</span> <span style="background-color:#2ea043;color:#2ea043">|</span> U           openBandFlyout: (id) =&gt;</span>
<span style="background-color:rgba(46,160,67,0.15)">583  <span style="color:#2ea043">+</span> <span style="background-color:#f85149;color:#f85149">|</span>               setBandOpenRequest((prev) =&gt; ({ id, nonce: (prev?.nonce ?? 0) + 1 })),</span>
584    <span style="background-color:rgba(46,160,67,0.40);color:rgba(46,160,67,0.40)">|</span>           };
585    <span style="background-color:rgba(46,160,67,0.40);color:rgba(46,160,67,0.40)">|</span>         }
  ...
598    <span style="background-color:rgba(46,160,67,0.40);color:rgba(46,160,67,0.40)">|</span>         layout.openFloatCount,
599    <span style="background-color:rgba(46,160,67,0.40);color:rgba(46,160,67,0.40)">|</span>         layout.restore,
<span style="background-color:rgba(46,160,67,0.15)">600  <span style="color:#2ea043">+</span> <span style="background-color:#2ea043;color:#2ea043">|</span> U       layout.isBandPinned,</span>
601    <span style="background-color:rgba(46,160,67,0.40);color:rgba(46,160,67,0.40)">|</span>       ]);
602          
  ...
623    <span style="background-color:rgba(46,160,67,0.40);color:rgba(46,160,67,0.40)">|</span>                 renderPanel={guardedRenderPanel}
624    <span style="background-color:rgba(46,160,67,0.40);color:rgba(46,160,67,0.40)">|</span>                 onPillGripDown={onGripDown}
<span style="background-color:rgba(46,160,67,0.15)">625  <span style="color:#2ea043">+</span> <span style="background-color:#2ea043;color:#2ea043">|</span> U               openRequest={bandOpenRequest}</span>
<span style="background-color:rgba(46,160,67,0.15)">626  <span style="color:#2ea043">+</span> <span style="background-color:#f85149;color:#f85149">|</span>                 onOpenRequestHandled={() =&gt; setBandOpenRequest(null)}</span>
627    <span style="background-color:rgba(46,160,67,0.40);color:rgba(46,160,67,0.40)">|</span>               /&gt;
628    <span style="background-color:rgba(46,160,67,0.40);color:rgba(46,160,67,0.40)">|</span>             &lt;/div&gt;
  ...
861    <span style="background-color:rgba(46,160,67,0.40);color:rgba(46,160,67,0.40)">|</span>                 renderPanel={guardedRenderPanel}

```
... trimmed. The full comment covered 3 files and 6 uncovered lines.
```
