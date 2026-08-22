#!/usr/bin/env bash
# upload-badges.sh — #2533. Ship shields.io endpoint JSONs to MinIO.
#
# WHY THIS IS A SCRIPT AND NOT INLINE YAML
#   It was inline in ci.yml's `badges` job, which was the only producer. #2300
#   phase 3 retired the `smoke` job, and with it the only thing that measured
#   e2e on a push to main — so the `e2e` badge moved to e2e-full.yml, which is
#   where the full suite actually runs (nightly deploy gate + the 19:00 cron).
#   Two producers, one upload path: duplicating ~45 lines of ssh/scp/mc into a
#   second workflow is how the two drift.
#
# Usage:  scripts/ci/upload-badges.sh <dir-of-json-files>
# Env:    DEPLOY_USER, DEPLOY_HOST (and an ssh key already set up by the caller)
#
# Uploads only the files that EXIST — #2308: naming a missing file fails the
# whole `mc cp` and would take the other badges down with it.
set -euo pipefail

SRC_DIR="${1:?usage: upload-badges.sh <dir-of-json-files>}"
: "${DEPLOY_USER:?DEPLOY_USER is required}"
: "${DEPLOY_HOST:?DEPLOY_HOST is required}"

# #2533 — a UNIQUE remote staging dir per invocation. This used to be a fixed
# `~/tmp/badges` with an `rm -f *.json` before the copy, which was safe while
# ci.yml's `badges` job was the only producer. It is not any more: e2e-full.yml
# now produces the `e2e` badge, and two overlapping runs (a push to main while
# the nightly gate finishes, say) would have the second one's `rm` delete the
# first one's staged files between its scp and its `mc cp` — failing a job with
# a missing file it had just written. Per-run dirs make that unreachable.
REMOTE_DIR="tmp/badges-$$-$(date +%s)"

ls -la "$SRC_DIR"
# Hand off to the deploy host: scp the JSONs, then exec mc inside docker
# there (--network host so it reaches darkwatch-minio on :9000).
# Credentials come from the deploy env file already on the host.
ssh -i ~/.ssh/id_ed25519 "${DEPLOY_USER}@${DEPLOY_HOST}" "mkdir -p ~/${REMOTE_DIR}"
scp -i ~/.ssh/id_ed25519 "$SRC_DIR"/*.json "${DEPLOY_USER}@${DEPLOY_HOST}:~/${REMOTE_DIR}/"
ssh -i ~/.ssh/id_ed25519 "${DEPLOY_USER}@${DEPLOY_HOST}" "REMOTE_DIR='${REMOTE_DIR}' bash -s" <<'EOSSH'
set -euo pipefail
# Read values from .env.deploy WITHOUT sourcing it. Sourcing under
# `set -u` blew up when one of the secret values contained a literal
# `$D…` substring (bash would try to expand `$D…` and find it
# unbound). grep+cut treats values as plain strings.
ENV_FILE="$HOME/services/darkwatch/.env.deploy"
getval() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
MINIO_ENDPOINT="$(getval MINIO_ENDPOINT)"
MINIO_ROOT_USER="$(getval MINIO_ROOT_USER)"
MINIO_ROOT_PASSWORD="$(getval MINIO_ROOT_PASSWORD)"
MINIO_BUCKET="$(getval MINIO_BUCKET)"
# URL-encode credentials before embedding them in the MC_HOST URL.
# Without this, special chars in the password (`$`, `/`, `@`, `:`,
# `%`, etc.) made `mc` compute the wrong S3 signature and every cp
# failed with "signature does not match".
urlenc() { python3 -c 'import sys, urllib.parse as u; sys.stdout.write(u.quote(sys.argv[1], safe=""))' "$1"; }
ENC_USER="$(urlenc "$MINIO_ROOT_USER")"
ENC_PASS="$(urlenc "$MINIO_ROOT_PASSWORD")"
ENDPOINT_AUTH="${MINIO_ENDPOINT/:\/\//://${ENC_USER}:${ENC_PASS}@}"
# #2308 — copy only the badges this run actually produced. On a
# tree-gate skip the two coverage JSONs are deliberately absent (see
# the generator above), and naming a missing file would fail the whole
# `mc cp`, taking the version + build badges down with it. Built from
# the host paths, rewritten to the container's bind-mount path.
# `if`, not `[ -f … ] && …`: this block runs under `set -e`, where a
# for-loop whose last command returns 1 aborts the whole script.
BADGES=""
for b in build e2e server-coverage client-coverage version; do
  if [ -f "$HOME/$REMOTE_DIR/$b.json" ]; then BADGES="$BADGES /badges/$b.json"; fi
done
echo "uploading badges:$BADGES"
[ -n "$BADGES" ] || { echo "no badge files to upload"; exit 0; }
docker run --rm --network host \
  -v "$HOME/$REMOTE_DIR:/badges:ro" \
  -e "MC_HOST_dw=${ENDPOINT_AUTH}" \
  minio/mc:RELEASE.2025-08-13T08-35-41Z \
  cp $BADGES \
    "dw/${MINIO_BUCKET}/site/"
rm -rf "$HOME/$REMOTE_DIR"
EOSSH

