# Example: the supply-chain bot

Real output, from Darkwatch PR #2652 (2026-09-04), reproduced verbatim.

Wraps a Socket.dev scan. The design decision worth noting is **diff-forward
scanning**: it reports only alerts this PR *adds*, against a trusted baseline of
the existing tree. A scanner that re-reports the same 72 findings on every PR is
one people learn to scroll past, which makes it worse than no scanner.

It also states plainly that these four findings do not block the merge, so the
signal ("something new arrived") stays separate from the gate ("you may not
merge").

---

<!-- supply-chain-bot:v2 -->

## 🛡️ Supply-chain alerts (net-new in this PR)

> ℹ️ Informational findings — none block the merge.

_Socket scan-diff: 72 added alerts → 4 net-new (de-duped). Manifests scanned — head: 5, base: 5._

<details><summary>ℹ️ 4 informational findings (none block)</summary>

| Package | Alert | Severity |
|---|---|---:|
| [sharp@0.35.4](https://socket.dev/npm/package/sharp) | Debug access (`debugAccess`) | low |
| [sharp@0.35.4](https://socket.dev/npm/package/sharp) | Env vars (`envVars`) | low |
| [sharp@0.35.4](https://socket.dev/npm/package/sharp) | Shell access (`shellAccess`) | middle |
| [sharp@0.35.4](https://socket.dev/npm/package/sharp) | Url strings (`urlStrings`) | low |

</details>

_Scanned diff-forward vs `main`; the existing tree is trusted (see #723 baseline)._
