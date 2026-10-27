# Rainbow Video Road

A 3D kart racer in the spirit of *Rainbow Road*, where the road itself is made of
video. Point the game at a folder of clips and every slat of the floating track becomes
a live, pixelated, hue‑shifted segment of one of your videos — a rainbow you drive on.

- Procedurally generated looping track in space (seeded; some layouts bridge over themselves)
- Built‑in **track editor**: drag points on a top‑down map and an elevation strip while the
  3D track rebuilds live; save, export, import and share tracks as links
- Each slat tile streams a clip from your folder, pixelated and recoloured in a shader
- Arcade driving: acceleration, drifting with mini‑turbos, banked corners
- Three AI rivals (a princess, a gorilla and a mushroom charioteer) with a starting grid,
  bumping and a race position in the HUD
- Pickups: boost orbs, shields, coins (a little extra top speed each) and **?** item boxes
  that give a held item — boost, shield, a 3‑shot **laser** that bolts onto your kart, or a
  cone / mud patch to drop behind you
- Obstacles: blocks (ricochet, spin, stop), cones (knocked flying off the road) and mud
  (slows you down)
- No barriers by default: drive off the edge and a **space god** swoops down, beams you up
  and puts you back on the road (guard rails are still an option in Settings)
- Chase / far / hood cameras, lap timing, bloom, gamepad support
- Clips are read directly by your browser — nothing is uploaded anywhere

## Run it

```bash
npm install
npm run dev
```

Open the printed URL (default `http://localhost:5173`), click **Choose video folder**
and pick a folder that contains video files. You can also drop a folder onto the page.

Build a static version with `npm run build` (output in `dist/`, serves from any static host).

Every push to `main` is built and deployed to GitHub Pages by `.github/workflows/pages.yml`:
**https://vectorless.github.io/rainbow-video-road/**

## Controls

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Accelerate / brake‑reverse | `W` `S` or `↑` `↓` | RT / LT |
| Steer | `A` `D` or `←` `→` | Left stick |
| Drift (release for a mini‑turbo) | `Shift` or `Space` | A |
| Use held item | `E` | LB / RB |
| Reset to the road | `R` | Y |
| Change camera | `C` | X |
| Pause | `Esc` or `P` | Start |

## Track editor

Open it from the main menu (or the pause menu). The left panel shows the track from above
and its elevation profile; the 3D view behind it rebuilds as you edit.

- **Drag** a point to move it · **double‑click** empty space to add a point to the nearest
  segment · **right‑click** (or `⌫`) to remove one · wheel zooms, drag empty space to pan,
  `F` fits the view
- Drag a point **up or down in the elevation strip** to change its height
- **Road width** and **Banking** sliders apply to the whole track; select a point and tick
  **Bank at point … by hand** to set its banking angle yourself (the road eases between
  points, so a run of hand-set points makes a banked section)
- **Items**: pick a tool under the map (item box, boost, shield, coin, block, cone, mud) and
  click the road to place it; drag items to move them, right‑click or `⌫` to remove.
  **Auto items** scatters a generated set, **Clear items** removes them all
- **Set start here** makes the selected point the start/finish line
- Warnings flag corners too tight for the road width, very steep slopes, and places where
  the track crosses itself without enough vertical clearance (crossings with room are
  drawn as bridges)
- **Test drive** races from the selected point; `Esc` pauses and the pause menu takes you back
- **Save** keeps tracks in the browser ("Load a saved track…" lists them), **Export / Import**
  move them as `.json` files, and **Copy share link** puts the whole track in the page URL
- `⌘Z` / `Ctrl+Z` undo, `⇧⌘Z` / `Ctrl+Y` redo. Drag the 3D view to orbit, wheel to zoom.

The game remembers the last track you used. Changing the **Track seed** in Settings goes
back to a generated layout.

## Rivals and the space god

The rivals are imported models (`public/models/*.glb`), each a driver and kart in one static
mesh. They are driven by `src/kart/AIDriver.js`, which produces the same throttle/steer
input the player's controls do, so they obey the same physics. They aim for a racing line
on the inside of the bends, go round karts ahead of them, and rubber‑band a little toward
the player. **Rival racers** and **Rival pace** are in Settings.

Any kart that falls off is rescued by its space god (`src/kart/SpaceGod.js`, a Cthulhu model
with a rainbow halo), which carries it back to the last spot it was safely on the road. `R`
still puts you back at once.

## Pickups and obstacles

`src/items/ItemSystem.js` builds the track's items, checks every kart against them in track
space each frame and applies the effects; `src/kart/Kart.js` holds the per‑kart state
(shield, spin‑out, coins, mud, held item). Rivals steer round obstacles, aim for pickups and
use their items too. Generated tracks get a seeded set of items (`generateItems` in
`src/track/trackItems.js`).

### Adding a rival model

Models from generators such as Meshy are far too heavy (1–3 million triangles). Shrink them
with gltf-transform (a dev dependency), keeping the originals out of git in `incoming/`:

```bash
npx gltf-transform optimize incoming/original.glb public/models/name.glb \
  --compress false --texture-compress webp --texture-size 1024 \
  --simplify-ratio 0.03 --simplify-error 0.002   # aim for ~10–30k triangles
```

Then add an entry to `ROSTER` in `src/kart/Rivals.js`. `FigureKartModel` assumes the model
faces −X (as Meshy exports do); pass a different `yaw` if it doesn't.

### Track format

```json
{
  "version": 1,
  "name": "My track",
  "width": 14,
  "bankStrength": 1,
  "seed": 1337,
  "points": [[x, y, z], [x, y, z, bank], ...],
  "items": [{ "type": "block", "seg": 3, "u": 0.42, "x": -0.3 }, ...]
}
```

`points` are the control points of a closed centripetal Catmull‑Rom spline (4–64 of them;
the first one is the start line). An optional 4th number is banking set by hand at that
point, in degrees (positive lifts the right edge). Each item sits on segment `seg` (point
`seg` → `seg+1`), a fraction `u` along it and `x` across the road (−1..1 of the half width);
`type` is one of `itembox`, `boost`, `shield`, `coin`, `block`, `cone`, `mud`. `width` is the road width in world units; `bankStrength`
scales the automatic banking (0 = flat). Share links hold the same JSON, deflated and
base64url‑encoded in the URL hash.

## How the video road works

`src/video/VideoPool.js` keeps a small pool of `<video>` elements (default 8, adjustable
in Settings). Clips from the chosen folder are dealt out to the pool round‑robin; every
*N* seconds a stream moves on to the next clip (starting at a random point if the clip is
long), so over time every clip in the folder gets its turn on the track. Each stream is a
`THREE.VideoTexture`.

`src/track/TrackMesh.js` slices the track into slat rows and assigns each tile to a
stream, merging all tiles of a stream into one mesh (one draw call per stream).

`src/track/slatShader.js` does the look: it pixelates the clip in tile space, converts to
HSV and either replaces the hue with the slat's rainbow hue (colourise) or rotates the
clip's own hues by it (hue‑shift) — the *Video blend* slider mixes the two — then adds a
glowing rainbow border to every tile and fogs the road out into the void.

Before a folder is chosen (or for a stream that has nothing to play) the slats show
procedural animated test patterns, so the track is never blank.

### Folder picking

Chrome and Edge use the File System Access API (`showDirectoryPicker`) and walk the
folder recursively. Other browsers get a `webkitdirectory` file input. Dropping a folder
onto the page works everywhere that supports directory drops. Files that the browser
cannot decode are skipped automatically and counted as "unplayable" in the HUD.

### Performance notes

Eight simultaneously decoding videos is a lot for a laptop if the clips are 4K. If the
game stutters, lower **Simultaneous clips** or **Render scale** in Settings, turn off
**Bloom**, or use a folder of smaller clips (720p is plenty — the road pixelates them anyway).

## Project layout

```
index.html                 menus, HUD, settings panel
src/main.js                game bootstrap, state machine, settings wiring
src/core/                  seeded PRNG, persisted settings
src/track/TrackPath.js     closed spline + banked moving frames, generator, JSON format
src/track/trackStore.js    saved-track library, export/import, share links
src/track/TrackMesh.js     slat tiles, rails, start gate
src/editor/TrackEditor.js  the track editor (map + elevation canvases, undo, validation)
src/track/slatShader.js    pixelate + hue-shift material, rail material
src/video/VideoPool.js     the pool of <video> streams and textures
src/video/folderPicker.js  folder selection (FS Access API / input / drag & drop)
src/video/fallbackTextures.js  procedural textures used before clips load
src/kart/Kart.js           arcade driving model (track space), falling and rescue states
src/kart/KartModel.js      the player's kart, built from primitives
src/kart/FigureKartModel.js  wraps an imported model as a kart
src/kart/AIDriver.js       steering/throttle for computer racers
src/kart/Rivals.js         rival roster, starting grid, bumping, race positions
src/kart/SpaceGod.js       the rescuer that carries fallen karts back to the road
src/kart/KartGear.js       shield bubble + laser cannons that attach to any kart
src/track/trackItems.js    item types, placement format, editor remapping, generated items
src/items/ItemSystem.js    item runtime: collisions, effects, respawns, flying cones, lasers
src/items/itemMeshes.js    item meshes
src/kart/Input.js          keyboard + gamepad
public/models/             optimised rival models (GLB)
src/camera/ChaseCamera.js  chase / far / hood cameras and the menu fly‑over
src/world/Space.js         stars, nebulae, planets, lights
src/ui/                    HUD and settings panel bindings
```

## Tech

[Vite](https://vite.dev) + [three.js](https://threejs.org), no framework. The only
browser APIs beyond WebGL are `<video>`, object URLs and the folder pickers.
