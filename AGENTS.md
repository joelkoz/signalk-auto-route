# Agent Instructions

Before changing or debugging this repository, read in this order:

1. `README.md` — end-user documentation. Keep it user-facing; developer
   material belongs here and in `REQUIREMENTS.md`.
2. `REQUIREMENTS.md` — the authoritative implementation spec for this plugin:
   objective, architecture, engine algorithm, parameters, manifest contract,
   boundaries, acceptance criteria, and test plan.
3. The Plotter Extensions API specification — the durable public home is the
   proposed REST-API docs under `SignalK/signalk-server`
   (`docs/develop/rest-api/proposed/`) and the reference extensions
   `signalk-instrument-widgets` and `signalk-poi-search`. The `routes`
   capability (live route edit buffers + `route.*` methods/events) is the
   surface this extension exercises.

## What this plugin is

A reference **plotter extension** (the Signal K `plotterExtensions` resource
type) that contributes a toolbar button + parameter panel plus a server-side
**land-avoidance routing engine**. The user draws a route on the chart, opens
the Auto Route panel, sets a clearance margin, and presses **Auto route**; the
plugin inspects each segment and, where the straight path crosses charted land,
inserts via-points routing around it, writing the result back to the host's
live route edit buffer via `route.replace`.

It is a **land-avoidance convenience, NOT a navigation-safety planner.** It
avoids charted land (`LNDARE`) only — never depth, shoals, rocks, obstructions,
or COLREGs. The panel shows a persistent safety caveat to this effect.

The land geometry comes from the user's own **vector MBTiles charts** (the
`LNDARE` layer of S-57-derived vector tiles, as produced by
`signalk-charts-provider-simple`), read directly with `node:sqlite`. The
relationship to that provider is an App Store **recommendation**
(`signalk.recommends`), not a hard dependency.

## Repository layout

```
plugin/          Plugin entry (CommonJS) run by the Signal K server.
  index.js       Registers the read-only plotterExtensions provider, mounts
                 the static panel assets and the /route REST endpoint. The
                 ONLY Signal-K-coupled layer.
  route-endpoint.js  POST handler: validate {points, params} → land source →
                 engine → expanded points. Transport-agnostic core
                 (handleRouteRequest) for testability.
engine/          PURE, host-agnostic routing core (geometry in, geometry out).
  geometry.js    Segment intersection, point-in-polygon, polygon crossing,
                 ring offset, bbox. ZERO external deps.
  visibility.js  Visibility-graph construction over obstacle vertices.
  pathfind.js    A* shortest path (binary-heap) over the visibility graph.
  route.js       Per-segment orchestration → expanded geometry (expandRoute).
  cache.js       LRU cache (chart|bbox|zoom → polygons).
  land-source.js The ONE engine file that touches the outside world: chart
                 discovery + MBTiles LNDARE extraction. Lazily loads the MVT
                 decode deps (@mapbox/vector-tile + pbf).
src/web/         Panel browser source (plain JS + CSS) on
                 signalk-plotterext-bus/extension.
scripts/         build.mjs — esbuild bundles src/web → public/.
public/          Built assets, committed. Served at
                 /plotterext/signalk-auto-route/. Generated — do not hand-edit.
test/            node --test suites (engine core, cache, endpoint, manifest,
                 land-source pure helpers).
```

## Build / test / run

```sh
npm install
npm run build     # bundle src/web -> public/
npm test          # node --test (engine core + plugin contract)
```

The **engine core tests need zero external dependencies** — they run offline
against synthetic polygons. `@mapbox/vector-tile` + `pbf` are required only by
`land-source.js` (lazy-loaded) when actually reading a chart; the unit suite
never touches them.

End-to-end testing needs a Signal K server with this plugin enabled, a vector
chart with an `LNDARE` layer covering the test area, and a chartplotter host
implementing the `routes` capability (Freeboard-SK is the reference). Draw a
route across a charted landmass and press Auto route.

## Engineering rules (must not be violated)

- **The engine core is pure and host-agnostic.** `geometry/visibility/pathfind/
  route/cache` have NO Signal K coupling and NO external dependencies. Keep it
  that way so it stays offline-unit-testable and reusable. `land-source.js` is
  the only place the file system / `node:sqlite` / decode deps appear, and it
  lazy-loads the decode deps.
- **Serve UI assets from a public top-level static route, not `/plugins/*`.**
  The plugin mounts `public/` itself at `/plotterext/signalk-auto-route`.
  `/plugins/*` is admin-gated and breaks read-only users. Do NOT add the
  `signalk-webapp` keyword — these pages only load inside a host iframe.
- **The resource provider stays read-only.** `setResource`/`deleteResource`
  reject; the manifest is code, not user data.
- **Chart files are read-only.** Open MBTiles with `readOnly: true`. Never
  write to or modify chart data.
- **Operate only on the live route buffer.** Persistence is the user's choice
  via the host's save UI. Never delete a persisted route resource as a side
  effect of editing a buffer. Never modify the buffer on error.
- **Fail friendly.** No qualifying vector chart for the area → typed
  `land-source/none` (HTTP 422) → the panel shows the install-charts message
  and makes no change. Never present this as hazard-aware routing. The safety
  caveat must stay visible in the panel.
- **Recoverable feature-detection failures** (no vector chart, missing
  `LNDARE`, missing express) → `console.warn` / `app.error` + typed error to
  the panel; internal tracing → `app.debug()`. Never `console.error` for an
  expected condition.
- **Guard everything in the request path.** `handleRouteRequest` never throws;
  bad input → 400, no land source → 422, anything else → 500. A broken request
  must never crash the Signal K process.
- **Cap inserted via-points** (`params.maxViaPoints`) and keep computation
  bbox-scoped and cached.
- **Never bump the version** in a contributor PR — maintainers own versioning.
  Follow `type(scope): …` commit/PR titles (scope e.g. `route`, `engine`,
  `charts`).
- Rebuild and commit `public/` in the same change as any `src/web` edit.

## Known approximations / follow-ups

- **Tile-edge polygon stitching is not done in v1** (`land-source.js` TODO):
  `LNDARE` fragments clipped at tile borders are returned separately. Usually
  adequate for the visibility router but a landmass split across a seam could
  leave a thin gap. A proper fix unions adjacent-tile fragments before the
  engine sees them.
- **Geometry is planar** in lon/lat degrees (documented in `geometry.js`). The
  clearance margin is converted metres→degrees at the route's mean latitude so
  the one place absolute scale matters is correct; competing-detour selection
  and crossing tests are scale-invariant.
- **`ring offset` is a bisector approximation**, not a true Minkowski buffer;
  fine for the modest clearances used, can self-intersect at sharp concave
  corners for large offsets.
