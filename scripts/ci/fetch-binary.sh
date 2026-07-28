#!/usr/bin/env bash
#
# fetch-binary.sh — download a CI helper binary, retrying transport failures.
#
# WHY THIS EXISTS (#2010)
#   Three workflows pull the MinIO server + client binaries fresh from
#   dl.min.io on every run (e2e-full, visual-regression, ci's affected tier).
#   They did it with a bare `curl -sSL`, so under `set -e` a single corrupted
#   TLS record took the WHOLE job with it, before a single spec ran:
#
#     curl: (56) OpenSSL SSL_read: error:0A000119:SSL routines::decryption
#           failed or bad record mac, errno 0
#
#   That killed the 2026-07-27 midday e2e-full (which then filed #1999 with an
#   empty failing-spec list, because the run died before the suite) and the
#   2026-07-28 nightly, taking the deploy gate with it. ~100MB over a flaky
#   link is exactly the shape of transfer that eats an occasional bad record.
#
#   Retrying lives HERE rather than in `curl --retry-all-errors` for two
#   reasons: the flag needs curl >= 7.71 and the jobs run in three different
#   container images, and `--retry` alone does NOT cover exit 56 (a transport
#   read failure, not an HTTP status). A loop is version-proof and explicit.
#
# SAFETY
#   The body lands in a `.part` file and is moved into place only after curl
#   exits 0 with a non-empty result — a truncated or empty download can never
#   be chmod +x'd and executed as if it were the real binary.
#
# USAGE
#   scripts/ci/fetch-binary.sh <url> <dest> [attempts]
#
#   FETCH_RETRY_DELAY   seconds between attempts (default 5; tests set 0)
#
# Exit codes:
#   0 — downloaded to <dest>
#   1 — every attempt failed (dest is left absent)
#   2 — usage error

set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: fetch-binary.sh <url> <dest> [attempts]" >&2
  exit 2
fi

URL="$1"
DEST="$2"
ATTEMPTS="${3:-5}"
DELAY="${FETCH_RETRY_DELAY:-5}"

tmp="${DEST}.part"

for attempt in $(seq 1 "$ATTEMPTS"); do
  rm -f "$tmp"

  status=0
  curl -fsSL --connect-timeout 20 --max-time 600 "$URL" -o "$tmp" || status=$?

  if [ "$status" -eq 0 ] && [ -s "$tmp" ]; then
    mv "$tmp" "$DEST"
    echo "fetch-binary: $URL -> $DEST (attempt $attempt/$ATTEMPTS)"
    exit 0
  fi

  if [ "$status" -eq 0 ]; then
    echo "fetch-binary: EMPTY body from $URL (attempt $attempt/$ATTEMPTS)" >&2
  else
    echo "fetch-binary: curl exit $status for $URL (attempt $attempt/$ATTEMPTS)" >&2
  fi

  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep "$DELAY"
  fi
done

rm -f "$tmp"
echo "fetch-binary: giving up on $URL after $ATTEMPTS attempts" >&2
exit 1
