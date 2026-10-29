# Rainbow Video Road — spec and handover

This document is for a developer (or another Claude instance) picking up the project. It
covers what the game is, how it is built, what has been done so far and why, the
conventions to keep, and what is planned. `README.md` is the player-facing overview; this
file is the technical one.

Last updated: 2026-10-27.

---

## 1. What the game is

A browser 3D kart racer in the spirit of *Rainbow Road*. The track floats in space and is
made of **slats**: rectangular tiles, each streaming a live, pixelated, hue-shifted video
clip from a folder the player picks. Clips are read locally by the browser and are never
uploaded.

Built with **Vite + three.js**, plain ES modules, no UI framework, no TypeScript. Run it with
`npm install && npm run dev` (http://localhost:5173). `npm run build` writes a static site
to `dist/` (`base: './'`, so it works from any folder).

## 2. Feature list (current state)

| Area | What exists |
| --- | --- |
| Track | Closed centripetal Catmull-Rom spline, seeded generator (wobbly loops or figure-8s that bridge over themselves), automatic banking, slat mesh with video tiles, start gate, optional guard rails |
| Editor | Top-down map + elevation strip, live 3D rebuild, add/move/remove points, width/banking sliders, **banking set by hand per point**, **item placement tools**, set start, warnings (tight corners, steep slopes, low-clearance crossings), undo/redo, save to the browser, export/import JSON, share links in the URL hash, test drive |
| Driving | Arcade model in track space: throttle, brake/reverse, steering, drift → mini-turbo, sideways push on bends softened by banking, falling off the edge |
| Rivals | 3 AI racers using imported GLB models (princess, gorilla, mushroom charioteer), starting grid, bumping between karts, race position (`Pos 2nd/4`) in the HUD, finish placing in the finish toast; they dodge obstacles, collect pickups and use items |
| Space god | When a kart (player or rival) falls off, the space god (imported Cthulhu model + rainbow halo + tractor beam) swoops in, beams it up, carries it back and sets it down on the road |
| Pickups | Item box (random held item after a 0.8 s roulette), boost orb, shield (6 s), coin (+1.2% top speed each, max 10; lose half on falling, 2 on a spin-out). Collected pickups come back after a few seconds |
| Held items | Boost, shield, laser (3 shots; side cannons appear on the kart; hitscan along the road, spins the first kart hit, a shield absorbs it), cone and mud (dropped behind you). Use with `E` / LB / RB |
| Obstacles | Block (solid: ricochet back, spin, stop), cone (knocked flying, bounces, drops off the road, comes back after 10 s), mud (top speed ×0.45 while on it). A shield ignores mud/cone slowdown and block spin-outs |
| Camera | Chase / far / hood modes (`C`), speed-sensitive FOV, menu fly-over, special framing while falling and while being rescued |
| Video | Pool of `<video>` decoders (default 8) dealt clips round-robin and rotated every N seconds; procedural fallback textures before clips load |
| Settings | Persisted in localStorage, all editable in the in-game settings panel |

## 3. Code map

```
index.html                   all DOM: menu, pause, HUD, settings panel, editor panel
src/main.js                  Game class: renderer, scene, state machine, settings wiring, race logic
src/core/settings.js         DEFAULTS + localStorage persistence + schema migrations
src/core/prng.js             seeded random (track generation, slat assignment)
src/track/TrackPath.js       spline, per-unit samples of the moving frame, generator, JSON format/validation
src/track/TrackMesh.js       slat tiles (one merged mesh per video stream), rails, start gate
src/track/slatShader.js      pixelate + hue-shift material, rail material, shared uniforms
src/track/trackStore.js      saved-track library, active track, export/import, share links
src/editor/TrackEditor.js    the track editor
src/kart/Kart.js             driving physics in track space; 'driving' | 'falling' | 'rescue' states
src/kart/KartModel.js        the player's kart, built from primitives
src/kart/FigureKartModel.js  wraps an imported GLB as a kart (same interface as KartModel)
src/kart/AIDriver.js         computer driver: outputs {throttle, steer, drift} like the player's input
src/kart/Rivals.js           rival roster, model loading, grid placement, bumping, progress/placing
src/kart/SpaceGod.js         the rescuer (Cthulhu model, primitive stand-in until loaded) and its rescue animation
src/kart/KartGear.js         shield bubble + laser cannons bolted onto any kart model
src/track/trackItems.js      item types (ITEM_TYPES), placement format + validation, remap helpers, generateItems
src/items/ItemSystem.js      item runtime: meshes, collisions/effects, respawns, flying cones, dropped items, lasers
src/items/itemMeshes.js      item meshes (shared geometry/materials) and the laser beam
src/kart/Input.js            keyboard + gamepad → axes + edge-triggered actions
src/camera/ChaseCamera.js    camera modes
src/world/Space.js           stars, nebulae, planets, the hemisphere + directional lights
src/video/                   VideoPool, folder picking, fallback textures
src/ui/Hud.js                HUD (speed, position, lap, times, boost, toasts, countdown)
src/ui/SettingsPanel.js      binds [data-setting] controls to Settings
public/models/               optimised models: blonde, gorilla, mushroom (rivals), cthulhu (space god)
incoming/                    raw model drops from the user (git-ignored, 40–100 MB each)
```

## 4. Core concepts and conventions

### 4.1 Track space
Everything on the road is placed with **track-space coordinates**: `s` (distance along the
track, wrapped to `[0, path.length)`), `lateral` (offset from the centreline, positive =
right) and an optional height along the road normal.

- `path.frameAt(s)` → `TrackFrame { position, tangent, right, normal, bank, curvature }`
- `path.pointAt(s, lateral, height)` → world position
- `path.wrap(s)`; signed differences between two `s` values must be unwrapped into
  `[-L/2, L/2]` (this pattern appears in `main.js`, `Rivals.js` and `AIDriver.js`)
- **Curvature sign:** positive = turning left. The inside of a left turn is negative
  `lateral`.
- `path.halfWidth` is half the road width (default width 14).

### 4.2 Kart model interface
A kart's visual model is any `THREE.Object3D` with `animate(dt, {speed, steer, drift, boost, hue})`.
Local axes: **forward = −Z, up = +Y, wheels on y = 0**. `KartModel` (primitives) and
`FigureKartModel` (imported GLB) both follow this. `Kart` positions and orients the model
in `syncModel()`.

### 4.3 Kart physics (`Kart.js`)
- `MAX_SPEED = 32` u/s. **The user asked for this to be halved "for the moment"** (it was
  64), so expect to restore or retune it. `ChaseCamera` imports `MAX_SPEED` instead of
  hard-coding it.
- `topSpeedScale` (default 1) scales top speed and acceleration; only the AI uses it.
- Steering changes `heading` (angle relative to the road); sideways speed is
  `speed·sin(heading)` plus a bend push of `curvature·speed²·0.02·bankRelief`. **`AIDriver`
  copies this formula and the `maxAngle` formula**, so if you change them in `Kart.update`,
  change them in `AIDriver.update` too.
- States: `driving` → (off the edge, rails off) `falling` → after 0.4 s `rescue` → `driving`.
  `respawn()` is the instant reset (the `R` key). `reset(s, lateral)` puts a kart on the
  grid.
- Each `Kart` owns a `rescuer` (`SpaceGod`). **Whoever creates a Kart must add both
  `kart.model` and `kart.rescuer` to the scene** (`main.js` does this for the player,
  `Rivals.js` for the rivals).

### 4.4 Game state machine (`main.js`)
`menu | countdown | racing | paused | editor`. Kart visibility goes through
`#setKartsVisible()` / `#kartsShown()`, which handle the player, the rivals and the space
gods together; don't set `kart.model.visible` directly.

Race state (`this.race`): `lap`, `lapsTotal`, `time`, `lapTime`, `best`, `finished`,
`finishTime`, `prevS`, `lapDistance` (for lap counting, resets each lap and is penalised for
driving backwards over the line), `progress` (total signed distance driven since the start,
never reset, used for positions), `startS`.

### 4.4b Items (`trackItems.js`, `ItemSystem.js`)
- Track JSON `items: [{ type, seg, u, x }]`: anchored to control-point segment `seg`, fraction
  `u` of its arc length, `x` = lateral / halfWidth. **Any editor operation that renumbers
  points must remap items**: `remapItemsForInsert / ForDelete / ForRotate` (verified: rotate and
  delete leave other items exactly in place; insert moves them ≤ ~1 unit as the curve reshapes).
- Optional 4th number on a point = banking set by hand in degrees (±45, positive lifts the right
  edge). `TrackPath.#applyPointBanks` eases from point to point (smoothstep); a hand-set point next
  to an automatic one blends into the automatic bank.
- `ITEM_TYPES[type]` gives `kind` (pickup/obstacle), trigger half-extents `hitS`/`hitL`,
  `respawn`, and editor colour. Collision is a track-space box test against a kart box
  1.5 × 0.9 half-extents.
- Kart-side item state lives on `Kart` (`shield`, `spinTime`, `coins`, `inMud`, `held`,
  `rolling`) with methods `spinOut`, `giveBoost`, `giveShield`, `addCoin`, `rollItem`,
  `takeItem`. `inMud` is reset and set by the ItemSystem each frame.
- `ItemSystem.onEvent(kart, what)` reports events (`boost`, `shield`, `block`, `lasered`,
  `laser-hit`, `shield-pop`, …); `main.js` turns the player's into toasts.
- Items beyond the road fog distance are hidden (`viewDistance`, set by `#setFog`), because
  standard materials aren't fogged the way the slat shader is.

### 4.5 Settings (`core/settings.js`)
Add a key to `DEFAULTS`, a control with `data-setting="key"` in `index.html` (and a
formatter in `SettingsPanel.formatValue` if needed), and handle the change in
`Game.#bindSettings`. **When you change a default that existing players have already saved**,
bump `SCHEMA` and list the key in `MIGRATIONS` so the saved value is dropped. That's how
`rails` was switched from on to off.

Race-related keys: `rails` (false), `rivals` (true), `rivalPace` (0.95), `laps` (3), `seed`.

### 4.6 Lights and materials
The scene has only a hemisphere and a directional light (in `Space.js`) plus the player
kart's under-glow point light. **Don't add lights that toggle on and off** (e.g. on the space
god): three.js recompiles shaders when the light count changes. Use emissive materials;
bloom makes them glow. Imported models have no environment map, so `tameMaterials()`
caps metalness at 0.3 (otherwise fully metallic materials render nearly black).

### 4.7 Code style
Match the surrounding code: ES classes, `#private` methods, JSDoc on public methods, a
short block comment at the top of each class explaining the idea, comments that explain
*why*, `const` constants in UPPER_SNAKE at the top of the file, and scratch vectors reused
via `this._tmp…` to avoid allocations every frame.

## 5. Work done in the latest session (2026-10-27)

1. **Top speed halved.** `MAX_SPEED` 64 → 32 (temporary, at the user's request). The camera FOV/pull now uses
   `MAX_SPEED`.
2. **Rival models.** The user supplied two Meshy-generated GLBs (a blonde princess in a red
   roadster, a gorilla in a buggy), 38 MB/1.1 M triangles and 101 MB/2.8 M triangles. They
   were shrunk with `@gltf-transform/cli` (now a dev dependency) to ~11k triangles and 1024 px
   WebP textures, ~1.4 MB each, in `public/models/`:
   ```bash
   npx gltf-transform optimize incoming/<file>.glb public/models/<name>.glb \
     --compress false --texture-compress webp --texture-size 1024 \
     --simplify-ratio 0.03 --simplify-error 0.002     # gorilla used --simplify-ratio 0.012
   ```
   Both models are complete driver + kart meshes with **no rig or animations**, facing **−X**.
   `FigureKartModel` turns them to −Z, scales them to 3.0 units long, sits them on y = 0, and
   fakes life with body lean and a little bounce.
3. **AI rivals** (`AIDriver`, `Rivals`):
   - Racing line: average curvature over a lookahead (10 + 0.9·speed) → aim for the inside
     of the bend (up to 75% of the usable half-width), plus a per-racer `lineOffset` and a slow
     sine wander.
   - Overtaking: the nearest kart within 14 units ahead near our line → go round it with a
     2.7-unit gap.
   - Steering: the sideways speed wanted (1.8 × lateral error, clamped to ±9) minus the bend push →
     `asin` → heading → steering input via the kart's `maxAngle`. Lifts to 20% throttle when
     the bend needs more than 95% of the steering available.
   - Pace: `topSpeedScale = pace (setting) × talent (roster) × rubberBand`, with the rubber band in
     `[0.88, 1.06]` based on the gap to the player (`gap/500`).
   - No AI drifting or boosting yet.
   - Grid: two staggered columns 6 units apart behind `startS`, rivals in front and **the
     player at the back**. Grid `s` values are unwrapped (negative = behind the line) and
     double as each racer's starting `progress`.
   - Bumping: track-space boxes 3.0 long × 1.8 wide. Nose-to-tail overlaps separate along
     `s` and share speed (the kart behind keeps 94%). Side-by-side overlaps shove apart
     sideways. Applies to the player too.
   - Placing: a rival finishes at `progress ≥ lapsTotal·L`. `Rivals.placeOf(progress, finishTime)`
     ranks finished racers by time, then the rest by progress.
   - Models load asynchronously. If they arrive during a countdown they join the grid;
     otherwise they join the next race. If a load fails, the race goes on without that racer.
4. **Barriers off, space god on.**
   - `rails` now defaults to **false** (settings schema 2 migration drops the saved value).
     **The user plans to add barriers deliberately later**, so the rails code, the
     `rails` setting and `Kart.rails` behaviour were kept intact; only the default changed.
     Future barriers will probably be per-section (part of the track data / editor) rather
     than all-or-nothing.
   - `SpaceGod`: procedural figure (robe cone, glowing head and eyes, rainbow halo,
     reaching arms, additive tractor-beam cone) with no lights. Timeline: arrive 0.55 s →
     lift 0.65 s → carry 1.3 s (arcing) → lower 0.55 s → release, then depart 0.9 s
     (rises and fades). The kart is put down at `lastSafeS`, centred, with speed 6 and a short
     blink. `R` during a rescue cancels it and resets at once.
   - Camera during a rescue: a high point behind the drop-off, aimed 35% of the way from
     the kart to the god.
5. **HUD:** a `Pos` readout (hidden when racing alone). The finish toast includes the
   placing.
6. **README** updated (rivals, space god, how to add a rival model, code map).

## 5b. Work done on 2026-10-27, later session: items, laser, banking, new models

1. **Pickups, held items and obstacles** as above, placeable in the editor, generated for seeded
   tracks (`generateItems`: 2–3 rows of 4 item boxes, 3 boosts, 3 lines of 5 coins, a shield,
   3 blocks, 2 clusters of 3 cones, 2 mud patches, kept away from the start).
2. **Laser** (user request): a held item from item boxes, 3 shots, twin cannons on the kart
   (`KartGear`), a beam drawn as a tube following the road, range 75, hit width 1.8.
3. **AI**: `AIDriver.#itemLine` steers round the nearest obstacle in its line (24 ahead) or
   toward a wanted pickup (32 ahead, ≤4 off the line); `#decideItem` uses boosts on straights,
   shields near obstacles or after 5 s, lasers when a kart is lined up ahead, and drops
   cones/mud on someone close behind.
4. **Banking per point** in the editor (user request: "banking segments, not just the whole track").
5. **New models**: `mushroom.glb` (third rival; from `incoming/Meshy_AI_mushroom_chariot_*`,
   simplify ratio 0.006 → 29k tris) and `cthulhu.glb` (space god; already 31k tris, only
   textures resized). Cthulhu faces +Z; `SpaceGod` turns it, scales to 7 units, puts its claws at
   the beam origin, and hangs the kart 4.2 below.
6. **Mushroom "turn the wheel" animation: not done.** The user believed the mushroom model was
   rigged, but the supplied GLB has no skin or animations (1 node, 1 mesh). They were asked to
   provide the rigged export; when it arrives, drive the arm/hand bones from `steer` in a
   model-specific `animate()`.

## 5c. Rival behaviour: personalities, grudges, race director (2026-10-29)

Asked for: rivals that interact with each other, ease off when far ahead so the player can
catch up, and get more competitive when the player leads. Design informed by:
- Pure's AI postmortem (Game Developer, "The Pure Advantage: Advanced Racing Game AI"): classic
  rubber-banding was rejected as easy to spot; instead bounded 0..1 skill offsets steer each AI
  toward a designer-set *target point* relative to the player, groups are spread by giving
  racers different targets, and the adjustment fades over the last 20% so the finish is decided
  by skill.
- Game Wisdom, "Explaining Rubber-Banding AI": visible rubber-banding erodes trust; keep help
  subtle, rule-based and switchable for experts.
- GRID (2019) / GRID Legends "Nemesis" system: repeated contact makes a specific AI hold a
  grudge and race that driver more aggressively; grudges cool off.
- Richard Burns Rally dev diary: AI drivers with temperaments players learn to recognise.
- Mario Kart: catch-up mainly through item odds by position, the same rule for everyone.

Implementation:
- **Personalities** (`ROSTER` in `Rivals.js`, traits 0..1): Princess clean (consistency 0.9) and
  defends (blocks a kart tailing her, defend 0.8), targetGap +25; Gorilla brawler (aggression
  0.85), targetGap 0; Mushroom trigger-happy (trigger 0.95), hangs back, targetGap −20.
- **Race director** (`Rivals.#direct`): gap = progress − player progress − targetGap. Ahead by
  30→250 ⇒ intensity 0→−1 (pace down to −9%); behind by 15→195 ⇒ 0→+1 (pace up to +6%). Intensity
  follows smoothly (rate 0.4/s); nothing in the first 6 s; the fighting pace bonus fades to 35%
  over the final 20% of the race; pace changes off when Settings → **Catch-up** is unticked
  (behaviour changes stay).
- **Intensity → behaviour** (`AIDriver`): fighting = more aggression, tidier line, later lift in
  corners, targets the player; easing = sloppier, lifts earlier, holds items longer and won't
  laser / drop hazards on a player who's behind.
- **Grudges**: lasered by X ⇒ +0.6 heat on X; hit X's dropped cone/mud ⇒ +0.35; side-by-side
  contact ⇒ +0.08 (capped at 0.6, 1.5 s cooldown per pair). Heat cools 0.04/s. Above 0.3 the
  grudge kart becomes the victim: bumped when alongside (aggressive drivers), laser lined up
  on it, hazards dropped in front of it. A rival reaching 0.7 on the player shows 💢 and toasts
  "<name> has it in for you!" (once a race).
- **Emotes** (`Emote.js`, sprite over the kart): 😠 hit, 😎 landed a hit, 😵 spun on a block,
  😜 passed the player, 😤 overtaken while fighting, 💢 nemesis.
- **Item odds by position** (`ItemSystem` ROULETTE front/back columns, `rankOf` from main):
  leader ≈ 30% cone, 28% mud, 12% laser; last ≈ 34% boost, 34% laser, 7% cone/mud.
- Verified (`smoke-cdp.mjs director`): parked player ⇒ rivals settle at ~0.91 pace; player
  teleported 260 ahead ⇒ rivals at ~1.05 and closing; two laser hits on the gorilla ⇒ nemesis
  toast; roulette percentages as above.

## 6. Testing approach

There is no automated test suite. Verification so far:
- `npx vite build` must pass (the >500 kB chunk warning is expected: three.js).
- **Headless Chrome smoke test over the DevTools protocol** (`scripts/smoke-cdp.mjs`): opens
  the dev server, starts a race through the debug hook `window.__rainbowRoad.game`, holds
  the up arrow, prints kart/rival state, forces falls (`kart.lateral = path.halfWidth + 1.5`)
  and saves screenshots. Software WebGL (SwiftShader) is slow, so wall-clock waits in the
  script are much longer in game time than they look. Judge with game-state values
  (`g.time`, `g.state`), not wall time.
- Scenarios: `race`, `fall`, `misc` (rival rescue, `R` mid-rescue, editor mid-rescue, settings),
  `items` (counts, block/cone/mud/drop), `laser`, `gallery` (paused close-ups of every item, the
  beam and the shield), `editor` (place/drag an item with real mouse events, per-point banking,
  share-link round trip), `remap` (items keep their world position across point edits).
- Things checked: rivals load (2), follow the line at ~26 u/s without falling off, the
  rescue goes `falling → rescue → driving` for the player and the rivals, `R` mid-rescue,
  opening the editor mid-rescue hides everything, toggling rivals and pace live, the Pos
  readout hides when racing alone.

## 6b. Hosting, link previews, icons

- Repo: https://github.com/vectorless/rainbow-video-road (public). Every push to `main` builds
  and deploys to **https://vectorless.github.io/rainbow-video-road/** via
  `.github/workflows/pages.yml` (Pages source = GitHub Actions).
- `index.html` carries Open Graph + Twitter card tags (`summary_large_image`). The og/twitter
  image URLs are **absolute** (crawlers need that); update them if the site moves.
- `public/og-image.jpg` (1200×630) is a staged in-game shot: `node scripts/smoke-cdp.mjs og <dir>`
  re-creates it (player firing a laser, the princess shielded, all rivals, the item box row, and
  the title overlay), then copy `<dir>/og-image.jpg` to `public/`.
- Icons: `public/favicon.svg` (source), `favicon-32.png` and `apple-touch-icon.png` (180) rendered
  from it with headless Chrome.

## 6c. Mobile / touch

- `src/ui/TouchControls.js`: on coarse-pointer devices (or after the first touch) `body.touch-ui`
  shows on-screen controls inside the HUD: drag on the left half to steer (analog, ±70 px = full
  lock), hold Brake / Drift, tap Item / Cam / Pause. Gas is automatic on touch. `Input.poll()`
  merges it with keyboard/gamepad (`input.touch`).
- Phones: pixel ratio capped at 1.5, speedo moves to the bottom centre, video status hidden,
  overlays scroll (flex + auto margins) and the menu tightens under 520 px height.
- Tested with Chrome's touch emulation (`smoke-cdp.mjs mobile` / `mobile-portrait`), not yet on a
  real phone.
- README images live in `docs/screenshots/` (`smoke-cdp.mjs readme <dir>` re-stages them).

## 7. Known limitations and ideas

- Top speed is temporarily halved; the AI pace and rubber band were tuned for 32 u/s.
- The AI doesn't drift, boost or take shortcuts, and can only see karts ahead of it.
- Rival models are rigid, so there are no spinning wheels.
- The space god is built from primitives; it could be swapped for a generated model using the
  same `gltf-transform` pipeline (it must stay light-free).
- 3 rivals (one per model); `ROSTER` in `Rivals.js` can take more entries, and the grid
  adapts to the count.
- A shielded kart doesn't knock others about in bumps (it just keeps its speed); a possible extra.
- The item roulette isn't weighted by race position yet.
- Rivals are not drawn on the editor map, and there's no minimap.
- The player always starts at the back of the grid.
- Possible next steps the user has mentioned: **deliberate barriers** (likely per-section, in the
  editor), **mushroom driver steering animation** (needs a rigged model), **GitHub Pages**
  deployment.
