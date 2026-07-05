#!/usr/bin/env bash
# Regenerate the #1089 visual-regression baselines on the Linux CI image so the
# committed *-chromium-linux.png snapshots match nightly CI / the #1494 per-PR
# gate. macOS-rendered PNGs do NOT match Linux Chromium, so baselines must be
# (re)generated here, not via a bare `playwright test --update-snapshots` on the host.
#
# Usage (from a worktree, with `darkwatch-maria` + `darkwatch-minio` up):
#   scripts/regen-visual-baselines.sh                 # regenerate all baselines
#   scripts/regen-visual-baselines.sh --grep laser    # only tests matching /laser/
#   scripts/regen-visual-baselines.sh --image forge.example.com/aaron/darkwatch-ci-playwright:1.61.1
#
# Requires: Docker, and the CI image pulled locally. Uses an ISOLATED DB
# (dw_visbase) on darkwatch-maria so the shared dev DB is untouched.
#
# IMPORTANT: keep this tag in lockstep with the image the visual-regression /
# e2e-full workflows run on (.forgejo/workflows/*.yml) — a mismatch regenerates
# baselines against a different browser build than the per-PR gate judges them
# with, reintroducing exactly the kind of lying baseline #1535 fixed.
set -euo pipefail

IMAGE="forge.example.com/aaron/darkwatch-ci-playwright:1.61.1"
GREP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    --grep)  GREP="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

WT="$(git rev-parse --show-toplevel)"
SNAP_REL="tests/e2e/visual-regression.spec.ts-snapshots"
[ -d "$WT/tests" ] || { echo "must run from inside the repo worktree" >&2; exit 1; }

# Credentials come from the worktree's server/.env (dev values).
ENVF="$WT/server/.env"
[ -f "$ENVF" ] || { echo "missing $ENVF (copy from the main checkout)" >&2; exit 1; }
DB_PASSWORD="$(grep -E '^DB_PASSWORD=' "$ENVF" | head -1 | cut -d= -f2-)"
DB_ROOT_PASSWORD="$(grep -E '^DB_ROOT_PASSWORD=' "$ENVF" | head -1 | cut -d= -f2-)"
MINIO_PASSWORD="$(grep -E '^MINIO_ROOT_PASSWORD=' "$ENVF" | head -1 | cut -d= -f2-)"
DB_USER="$(grep -E '^DB_USER=' "$ENVF" | head -1 | cut -d= -f2-)"

DBNAME="dw_visbase"
echo "==> creating isolated DB $DBNAME on darkwatch-maria"
docker exec darkwatch-maria mariadb -uroot -p"$DB_ROOT_PASSWORD" -e \
  "CREATE DATABASE IF NOT EXISTS $DBNAME; GRANT ALL PRIVILEGES ON $DBNAME.* TO '$DB_USER'@'%'; FLUSH PRIVILEGES;" 2>/dev/null

SRC="$(mktemp -d)/src"
echo "==> staging source copy at $SRC (no node_modules)"
mkdir -p "$SRC"
rsync -a --exclude=node_modules --exclude=.git --exclude=.superpowers \
  --exclude=client/dist --exclude=server/dist "$WT/" "$SRC/"

# GREP is passed into the container as an env var (NOT expanded into the heredoc),
# so a regex with `|` alternation / spaces is quoted safely. A bash array keeps
# the empty case from injecting a stray empty arg. This lets you regenerate
# several named screens in one run, e.g.:
#   --grep 'character-card|character-sheet|quick-inspect|level-up'
cat > "$SRC/_regen.sh" <<EOF
set -euo pipefail
cd /work
( cd server && npm ci --no-audit --no-fund && npm run build )
( cd client && npm ci --no-audit --no-fund && npm run build )
( cd tests  && npm ci --no-audit --no-fund )
( cd server && npm run db:migrate && npm run seed )
( cd /work && node server/dist/index.js >/tmp/server.log 2>&1 & )
for i in \$(seq 1 40); do s=\$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/auth/me 2>/dev/null || true); echo "\$s" | grep -qE '^(200|401)\$' && break; sleep 2; [ "\$i" -eq 40 ] && { echo SERVER_FAIL; tail -60 /tmp/server.log; exit 1; }; done
( cd client && API_PROXY_URL=http://localhost:3001 ./node_modules/.bin/vite preview --port 5173 >/tmp/vite.log 2>&1 & )
for i in \$(seq 1 40); do curl -s -o /dev/null http://localhost:5173 && break; sleep 2; [ "\$i" -eq 40 ] && { echo VITE_FAIL; tail -40 /tmp/vite.log; exit 1; }; done
cd tests
GREP_ARG=()
[ -n "\${GREP:-}" ] && GREP_ARG=(--grep "\$GREP")
# VISUAL_ALL_THEMES: regen always sweeps the full 13-theme matrix, even though
# the default per-PR run only compares the 4-theme subset (DEFAULT_THEMES in the
# spec) — otherwise a regen would silently leave 9 themes' baselines stale.
E2E_SERVER_URL=http://localhost:3001 E2E_BASE_URL=http://localhost:5173 VISUAL_ALL_THEMES=1 \
  ./node_modules/.bin/playwright test e2e/visual-regression.spec.ts "\${GREP_ARG[@]}" --update-snapshots --reporter=line
echo REGEN_OK
EOF

echo "==> running CI image to regenerate baselines"
docker run --rm -v "$SRC":/work -w /work \
  --add-host=host.docker.internal:host-gateway \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e NODE_ENV=test -e PORT=3001 \
  -e GREP="$GREP" \
  -e DB_HOST=host.docker.internal -e DB_PORT=3397 \
  -e DB_USER="$DB_USER" -e DB_PASSWORD="$DB_PASSWORD" -e DB_NAME="$DBNAME" \
  -e DATABASE_URL="mysql://$DB_USER:$DB_PASSWORD@host.docker.internal:3397/$DBNAME" \
  -e JWT_SECRET=e2e-test-secret -e ALLOW_TEST_HOOKS=true -e TEST_HOOK_SECRET=e2e-test-hook-secret \
  -e CLIENT_URL=http://localhost:5173 -e SOCKET_PER_USER_CAP=1000 -e SOCKET_PER_IP_CAP=1000 \
  -e MINIO_ENDPOINT=http://host.docker.internal:9000 \
  -e MINIO_ROOT_USER=darkwatch_admin -e MINIO_ROOT_PASSWORD="$MINIO_PASSWORD" \
  -e MINIO_BUCKET=darkwatch-images \
  -e MINIO_PUBLIC_BASE_URL=http://host.docker.internal:9000/darkwatch-images \
  "$IMAGE" bash /work/_regen.sh

echo "==> copying regenerated baselines back into the worktree"
mkdir -p "$WT/$SNAP_REL"
cp "$SRC/$SNAP_REL"/*.png "$WT/$SNAP_REL"/
echo "==> dropping isolated DB"
docker exec darkwatch-maria mariadb -uroot -p"$DB_ROOT_PASSWORD" -e "DROP DATABASE IF EXISTS $DBNAME;" 2>/dev/null || true
echo "Done. Baselines in $WT/$SNAP_REL:"
ls -1 "$WT/$SNAP_REL"
