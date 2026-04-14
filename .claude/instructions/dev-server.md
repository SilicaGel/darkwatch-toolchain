# Dev Server — Restart & Troubleshooting

## Clean restart

```bash
kill $(lsof -ti :5173) 2>/dev/null
rm -rf client/node_modules/.vite
cd client && npm run dev
```

## Stale compiled .js artifact problem

The `src/` tree once had compiled `.js` files alongside `.tsx` sources (from a prior `tsc` run). Vite resolves `.js` extension imports to actual `.js` files first, so stale artifacts silently shadow the `.tsx` sources — changes appear invisible even after a restart.

If changes don't show up in the browser after a clean restart, run:

```bash
find client/src -name "*.js" ! -name "*.test.js" | while read f; do
  base="${f%.js}"
  [ -f "${base}.tsx" ] || [ -f "${base}.ts" ] && rm "$f"
done
```

These files are not git-tracked, so deletion is safe.
