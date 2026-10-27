# Rainbow Video Road

Read `docs/SPEC.md` first: it covers the architecture, conventions (track space, the kart model
interface, settings migrations, no toggling lights), what was built and why, and what is
planned (e.g. deliberate barriers later; `MAX_SPEED` is temporarily halved).

- Run: `npm run dev` (http://localhost:5173). Check with `npx vite build`.
- Smoke test: `node scripts/smoke-cdp.mjs race <outdir>` while the dev server runs.
- Raw model drops go in `incoming/` (git-ignored); optimised GLBs live in `public/models/`.
