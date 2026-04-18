#!/usr/bin/env bash
# Queue-batches statusline for Claude Code.
#
# Line 1 (always): model · cwd basename · git branch [dirty] · context%
# Line 2 (only when today's batches are active):
#   queue: auth-routes ✓✓ · server-core ✓◐ · client-ux ◐○
#
# Glyphs per ticket (latest status wins):
#   ✓ complete   ◐ starting/working   ? blocked   ✗ failed   · unknown
#
# Hides the queue line once every today-log has a final `status=done`
# summary AND the log's mtime is >5 minutes old — so completed runs
# persist on the bar long enough to notice, then auto-clear.
set -u

# ── Line 1: mirrors ~/.claude/statusline-command.sh (colored, DIM 2-space separator,
# used-% with threshold colors). Keep this in sync if the user-level script changes.
input=$(cat)

dir=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // empty' 2>/dev/null)
model=$(printf '%s' "$input" | jq -r '.model.display_name // empty' 2>/dev/null)
branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null)

used_pct=$(printf '%s' "$input" | jq -r '.context_window.used_percentage // empty' 2>/dev/null)
five_hr=$(printf '%s' "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty' 2>/dev/null)

CYAN=$'\033[36m'
YELLOW=$'\033[33m'
MAGENTA=$'\033[35m'
GREEN=$'\033[32m'
RED=$'\033[31m'
ORANGE=$'\033[38;5;208m'
RESET=$'\033[0m'
DIM=$'\033[2m'
SEP="${DIM}  ${RESET}"

line1=""
[[ -n "$dir" ]]    && line1="${CYAN}$(basename "$dir")${RESET}"
[[ -n "$branch" ]] && line1="${line1}${SEP}${YELLOW}${branch}${RESET}"
[[ -n "$model" ]]  && line1="${line1}${SEP}${MAGENTA}${model}${RESET}"

if [[ -n "$used_pct" ]]; then
  ctx_int=$(printf '%.0f' "$used_pct")
  if   [[ $ctx_int -ge 90 ]]; then ctx_color="$RED"
  elif [[ $ctx_int -ge 70 ]]; then ctx_color="$ORANGE"
  else                             ctx_color="$GREEN"
  fi
  line1="${line1}${SEP}${DIM}ctx:${RESET}${ctx_color}${ctx_int}%${RESET}"
fi

if [[ -n "$five_hr" ]]; then
  fh_int=$(printf '%.0f' "$five_hr")
  if   [[ $fh_int -ge 90 ]]; then fh_color="$RED"
  elif [[ $fh_int -ge 70 ]]; then fh_color="$ORANGE"
  else                            fh_color="$GREEN"
  fi
  line1="${line1}${SEP}${DIM}5h:${RESET}${fh_color}${fh_int}%${RESET}"
fi

# ── Line 2: queue-batches status (today only, auto-clearing)
TODAY=$(date +%Y%m%d)
shopt -s nullglob
LOGS=(/tmp/queue-status/*-"${TODAY}".log)

line2=""
if [[ ${#LOGS[@]} -gt 0 ]]; then
  now=$(date +%s)
  out=""
  for log in "${LOGS[@]}"; do
    [[ -s "$log" ]] || continue
    batch=$(basename "$log" .log)
    short="${batch%-"${TODAY}"}"

    # Skip this batch if it's shipped (feat/<batch> branch is gone locally — either
    # merged + cleaned up, or never created). That's the strongest "done" signal.
    if [[ -n "$dir" ]] && ! git -C "$dir" show-ref --verify --quiet "refs/heads/feat/${batch}" 2>/dev/null; then
      continue
    fi

    # Secondary clear: log has a `ticket=all status=done` summary and hasn't been
    # touched in >5 min (preserves visibility briefly so the user can see it ended).
    mt=$(stat -f %m "$log" 2>/dev/null || stat -c %Y "$log" 2>/dev/null || echo 0)
    age=$(( now - mt ))
    if grep -q 'ticket=all status=done' "$log" 2>/dev/null && [[ $age -gt 300 ]]; then
      continue
    fi

    # Hard cap: anything older than 24h gets cleared regardless.
    if [[ $age -gt 86400 ]]; then
      continue
    fi

    glyphs=$(
      grep -oE 'ticket=#[0-9]+ status=[a-z-]+' "$log" |
      awk '
        {
          split($0, p, " ")
          t = p[1]; sub(/^ticket=/, "", t)
          s = p[2]; sub(/^status=/, "", s)
          status[t] = s
          if (!(t in ord)) ord[t] = ++seq
        }
        END {
          count = 0
          for (t in status) list[++count] = t
          for (i=1; i<=count; i++)
            for (j=i+1; j<=count; j++)
              if (ord[list[i]] > ord[list[j]]) {
                tmp = list[i]; list[i] = list[j]; list[j] = tmp
              }
          for (i=1; i<=count; i++) {
            s = status[list[i]]
            if      (s == "complete") g = "✓"
            else if (s == "blocked")  g = "?"
            else if (s == "failed")   g = "✗"
            else if (s == "starting" || s == "working") g = "◐"
            else                      g = "·"
            printf "%s", g
          }
        }
      '
    )
    [[ -z "$glyphs" ]] && continue
    out+="${short} ${glyphs} · "
  done
  [[ -n "$out" ]] && line2="queue: ${out% · }"
fi

# Emit. Two lines when queue is active; one line otherwise.
printf '%s' "$line1"
[[ -n "$line2" ]] && printf '\n%s' "$line2"
exit 0
