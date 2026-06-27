# signalk-auto-route — Requirements

This is the authoritative implementation spec for `signalk-auto-route`. It is
seeded from the project specification (whose durable public home is the Plotter
Extensions API proposed-spec under `SignalK/signalk-server`,
`docs/develop/rest-api/proposed/`, alongside the reference extensions).

## 1. Objective

A Signal K plugin that contributes a **plotter extension** providing
**land-avoidance auto-routing** to any host chartplotter that implements the
`routes` capability of the Plotter Extensions API. Freeboard-SK is the
reference host.

The user builds an ordinary route on the chart, opens the extension's panel
from a toolbar button, optionally tweaks parameters, and presses **Auto
route**. For every consecutive segment whose straight path crosses charted
land, the extension inserts via-points routing around the landmass — preserving
the user's deliberate via-points and only fixing the segments that need it. The
result is written to the host's **live route edit buffer**; the user reviews it
and decides whether to save.

The heavy computation runs **server-side** in the plugin and is reached over a
**plugin-private REST endpoint**. The land geometry comes from the user's own
**vector MBTiles charts** (the `LNDARE` layer of S-57-derived vector tiles).

**Non-objective (hard).** Land-avoidance convenience, **not** a
navigation-safety planner. Avoids charted land (`LNDARE`) only — never depth,
shoals, rocks, obstructions, or COLREGs.

## 2. Architecture

Three responsibilities:

1. **Extension manifest provider** — registers a read-only resource provider
   for the custom type `plotterExtensions`, returning this extension's manifest
   keyed by the plugin id.
2. **Static asset host** — serves the panel UI from a public, non-admin-gated
   route `/plotterext/signalk-auto-route/`.
3. **Routing engine + private REST API** — a server-side land-avoidance router
   at `POST /plotterext/signalk-auto-route/route`, called by the panel within
   the user's authenticated session.

The routing engine (`engine/*`) is pure and host-agnostic: geometry in,
geometry out, no Signal K coupling and no external dependencies. Only
`land-source.js` touches the file system / `node:sqlite` / MVT decode deps.

### 2.1 Manifest

```jsonc
{
  "signalk-auto-route": {
    "name": "Auto Route",
    "description": "Route around land between the points of a route.",
    "version": "<pkg.version>",
    "apiVersion": "1",
    "requires": ["buttons", "panels.iframe", "routes"],
    "optional": ["map", "units"],
    "buttons": [
      {
        "id": "open-auto-route",
        "title": "Auto Route",
        "slot": "mapToolbar",
        "icon": "alt_route",
        "action": { "type": "togglePanel", "panel": "auto-route-panel" }
      }
    ],
    "panels": [
      {
        "id": "auto-route-panel",
        "title": "Auto Route",
        "type": "iframe",
        "url": "/plotterext/signalk-auto-route/panel.html",
        "lifecycle": "keepAlive"
      }
    ]
  }
}
```

A host lacking `routes` never offers the extension. No background runtime in
v1.

### 2.2 Interaction flow

1. User builds a route in the host.
2. User taps **Auto Route** → panel opens.
3. Panel calls `route.list` and **locks onto a buffer** (§2.3), then
   `route.get` to read its points; it subscribes to `route.**` to follow edits.
4. User adjusts the clearance and presses **Auto route**.
5. Panel POSTs `{ points, params }` to the REST endpoint.
6. Engine resolves a land source for the route bbox; if none qualifies it
   returns `land-source/none` (HTTP 422) → the panel shows the friendly message
   and makes no change.
7. On success the engine returns the expanded geometry; the panel applies it
   with `route.replace`.
8. The host re-renders; the user reviews and saves via the host (or discards).

### 2.3 Buffer selection (v1 decision)

**Lock onto the single buffer; when several exist, the most-recently-created
(tracked via `route.created`, falling back to the last entry of `route.list`).
Zero buffers ⇒ prompt the user to draw a route first.** No explicit picker in
v1 — this keeps the panel simple. (An explicit picker is a possible later
enhancement if multi-buffer hosts make the implicit choice surprising.)

## 3. Routing engine

### 3.1 Land source — vector MBTiles `LNDARE`

- **Discovery** — scan the configured chart directory (and any explicit extra
  paths) for `.mbtiles`. Keep sources that are vector (`format === 'pbf'`),
  whose `vector_layers` include the land layer (default `LNDARE`, configurable),
  and whose `bounds` (if present) overlap the route's padded bbox.
- **Direct read** — open the qualifying `.mbtiles` read-only with `node:sqlite`;
  decode PBF tiles with `@mapbox/vector-tile` + `pbf` (lazy-loaded). No HTTP.
- **Extent** — read only the tiles intersecting the route's padded bbox at the
  chart's `maxzoom`.
- **Coordinate conversion** — tile-local (extent 4096) → lon/lat per tile.
- **Stitching** — v1 returns clipped fragments as-is (see follow-up below).
- **No qualifying source → typed `land-source/none`** → panel shows the
  install-charts message. No external download, no bundled fallback in v1.

### 3.2 Pathfinding

For each consecutive segment `(p_i, p_{i+1})`:

- If it does not cross any land polygon → keep it unchanged (original point
  objects preserved by identity).
- If it crosses land → build a **visibility graph** over the relevant land
  polygon vertices (offset outward by the clearance margin) plus the two
  segment endpoints, find the shortest path with **A\***, simplify
  (Douglas–Peucker), cap to `maxViaPoints`, and splice the via-points in.

Output is the full ordered point list ready for `route.replace`.

### 3.3 Performance & caching

- Lazy + bbox-scoped: never process beyond the route's padded bbox.
- Cache stitched land polygons keyed by `chart|mtime|zoom|bboxQuantized` (LRU,
  size-capped). The mtime in the key invalidates on chart file change.

## 4. Parameters (panel)

| Param          | Meaning                                                    | Default        |
| -------------- | ---------------------------------------------------------- | -------------- |
| `clearance`    | Safety margin kept off land (offset distance), user units  | 50 m (165 ft)  |
| `mode`         | `fix-segments` \| `full`                                    | `fix-segments` |
| `simplify`     | Via-point Douglas–Peucker simplification                   | on             |
| `maxViaPoints` | Cap on inserted via-points per crossing segment            | 50             |

Clearance is entered in the host's `units.length` preference (m or ft) and
converted to metres before POST; the engine converts metres → degrees at the
route's mean latitude.

## 5. REST endpoint contract

`POST /plotterext/signalk-auto-route/route`, same-origin, user session.

Request body: `{ points: RoutePoint[], params?: {clearance?, mode?, simplify?,
maxViaPoints?} }` where `RoutePoint = { position: [lon, lat, alt?], name?,
description? }`.

Responses:

- `200 { points, changed, segments, source }` — expanded route.
- `400 { error: 'bad-request', message }` — malformed / < 2 points / bad
  position.
- `422 { error: 'land-source/none', message }` — no covering vector chart.
- `500 { error: 'internal', message }` — unexpected; the server never crashes.

The transport-agnostic core (`handleRouteRequest`) never throws.

## 6. Boundaries

**Always:** treat chart files read-only; operate only on the live buffer; show
the persistent caveat *"Avoids charted land only — not depth, shoals, rocks, or
other hazards. Always review the route before navigating."*; fail friendly; cap
via-points; keep computation bbox-scoped and cached.

**Ask first:** adding a background runtime, an external/bundled fallback land
source, depth/hazard awareness, or any new host-API surface; running CodeRabbit
on a SignalK PR.

**Never:** present this as hazard-aware/safe-for-navigation routing; modify
chart data; delete a persisted route as a side effect of editing a buffer;
download chart/coastline data silently; hard-depend on a specific chart
provider.

## 7. Acceptance criteria

1. With the plugin enabled and a `routes`-capable host, the **Auto Route**
   button appears in the map toolbar and opens the panel.
2. A 2-point route across a charted landmass (with a covering vector chart)
   produces a path that does not intersect any `LNDARE` polygon within
   `clearance` and preserves the original endpoints. *(engine unit-tested)*
3. A multi-via-point route where only some segments cross land leaves clear
   segments unchanged and only inserts via-points into crossing segments.
   *(engine unit-tested)*
4. The buffer updates live (host re-renders) without a save; the user can then
   save via the host. *(manual)*
5. No qualifying vector chart for the bbox → the panel shows the friendly "no
   land data" message and makes no change. *(endpoint unit-tested)*
6. A second auto-route in the same waters reuses cached land geometry.
   *(cache unit-tested)*
7. The routing engine passes unit tests against fixture polygons independent of
   any running Signal K server. *(engine unit-tested)*
8. The panel's safety caveat is visible whenever results are shown.

## 8. Test plan

- **Engine unit tests** (`test/geometry|pathfind|route|cache.test.js`,
  `node --test`, no server, no external deps): segment/polygon intersection,
  point-in-polygon, visibility graph, A* correctness and near-optimality,
  expandRoute non-intersection + endpoint preservation + segment-only fixes +
  clearance honoured + via-point cap, LRU hit/miss/eviction.
- **Endpoint tests** (`test/endpoint.test.js`): request-schema validation
  (bad input → 400), `land-source/none` → 422, param sanitisation/clamping, and
  that the handler never throws.
- **Manifest/provider tests** (`test/manifest.test.js`):
  `listResources('plotterExtensions')` returns a manifest declaring
  `requires: [...,'routes']` and the button/panel wiring; read-only rejection;
  asset + endpoint mounts.
- **Land-source pure helpers** (`test/land-source.test.js`): tile-local→lon/lat
  conversion, bbox padding, discovery on a missing dir. (Full MVT decode + real
  MBTiles reads are covered by manual/integration testing against a fixture
  chart because `@mapbox/vector-tile` + `pbf` are not installed in the offline
  unit-test environment.)
- **Host integration (manual / Freeboard-SK)**: the §7 scenarios against the
  live route buffer.

## 9. Follow-ups / approximations (v1)

- **Tile-edge polygon stitching** is not implemented (`land-source.js` TODO):
  fragments clipped at tile borders are returned separately. A landmass split
  across a seam could leave a thin gap. Fix: union adjacent-tile `LNDARE`
  fragments before the engine sees them.
- **Planar geometry** in lon/lat degrees (documented). Clearance is scaled
  correctly via a per-latitude metres→degrees factor; crossing/detour tests are
  scale-invariant.
- **Ring offset** is a bisector approximation, not a true Minkowski buffer.
- **`full` mode** currently behaves like `fix-segments`; reserved for a future
  whole-route re-optimisation pass.
