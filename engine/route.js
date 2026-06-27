// Per-segment land-avoidance orchestration.
//
// ZERO external deps (composes geometry/visibility/pathfind). Host-agnostic:
// geometry in, geometry out — no Signal K coupling. The HTTP layer adapts
// route points to/from this module.
//
// A RoutePoint matches the Plotter Extensions API shape:
//   { position: [lon, lat, alt?], name?, description? }
// expandRoute preserves every original point object (identity + metadata) and
// only SPLICES new via-points (plain { position } objects) into the segments
// that cross land.

'use strict'

const { distance, segmentCrossesAny, outerRing } = require('./geometry')
const { buildVisibilityGraph } = require('./visibility')
const { astar } = require('./pathfind')

const DEFAULTS = {
  clearance: 50, // metres (converted to degrees per-route below)
  mode: 'fix-segments', // 'fix-segments' | 'full'
  simplify: true,
  maxViaPoints: 50 // cap on inserted via-points PER crossing segment
}

const LIMITS = {
  // The visibility graph is ~O(V^3) and runs SYNCHRONOUSLY in the Signal K
  // event loop, so the obstacle vertex count must be bounded or a complex
  // coastline freezes the whole server. Rings are simplified first; past this
  // cap the segment is refused with a friendly error rather than run away.
  maxObstacleVertices: 400
}

/** A typed, user-facing engine error the HTTP layer maps to a 422. */
function complexityError(message) {
  return Object.assign(new Error(message), { reason: 'route-too-complex' })
}

const METRES_PER_DEG_LAT = 111320

/** Metres → degrees, scaled for longitude compression at latitude `lat`. */
function metresToDegrees(metres, lat) {
  // Use the average of the lon and lat scale so the offset is roughly
  // isotropic in the planar lon/lat space the geometry code operates in.
  const cos = Math.max(0.05, Math.cos((lat * Math.PI) / 180))
  const perDegLon = METRES_PER_DEG_LAT * cos
  const degLat = metres / METRES_PER_DEG_LAT
  const degLon = metres / perDegLon
  return (degLat + degLon) / 2
}

function pos(point) {
  return [point.position[0], point.position[1]]
}

/**
 * Select the land polygons whose bounding box could affect segment (a,b).
 * Cheap AABB reject so the visibility graph only includes nearby obstacles.
 */
function relevantPolygons(a, b, polygons) {
  const minLon = Math.min(a[0], b[0])
  const maxLon = Math.max(a[0], b[0])
  const minLat = Math.min(a[1], b[1])
  const maxLat = Math.max(a[1], b[1])
  return polygons.filter((poly) => {
    const ring = outerRing(poly)
    let pMinLon = Infinity
    let pMaxLon = -Infinity
    let pMinLat = Infinity
    let pMaxLat = -Infinity
    for (const v of ring) {
      if (v[0] < pMinLon) pMinLon = v[0]
      if (v[0] > pMaxLon) pMaxLon = v[0]
      if (v[1] < pMinLat) pMinLat = v[1]
      if (v[1] > pMaxLat) pMaxLat = v[1]
    }
    // Overlap test (no clearance pad here; the offset happens in the graph).
    return !(
      pMaxLon < minLon ||
      pMinLon > maxLon ||
      pMaxLat < minLat ||
      pMinLat > maxLat
    )
  })
}

/**
 * Douglas–Peucker simplification of a [lon,lat] poly-line. Keeps the first and
 * last points; drops intermediate vertices within `tol` of the running chord.
 */
function simplifyPath(points, tol) {
  if (points.length <= 2 || tol <= 0) return points
  const keep = new Array(points.length).fill(false)
  keep[0] = true
  keep[points.length - 1] = true

  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [first, last] = stack.pop()
    let maxD = -1
    let idx = -1
    for (let i = first + 1; i < last; i++) {
      const d = perpDistance(points[i], points[first], points[last])
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > tol && idx !== -1) {
      keep[idx] = true
      stack.push([first, idx], [idx, last])
    }
  }
  return points.filter((_, i) => keep[i])
}

function perpDistance(p, a, b) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return distance(p, a)
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
  const proj = [a[0] + t * dx, a[1] + t * dy]
  return distance(p, proj)
}

/**
 * Compute via-points that route segment (a,b) around the relevant land
 * polygons, honouring `clearanceDeg`. Returns an array of [lon,lat]
 * intermediate points (excluding a and b), or null if no path is found.
 */
function detour(a, b, polygons, clearanceDeg, opts) {
  let obstacles = relevantPolygons(a, b, polygons)
  if (obstacles.length === 0) return []

  // Bound the visibility-graph cost. We already keep a clearance margin, so
  // mildly simplifying each obstacle ring is safe; then hard-cap the total
  // vertex count to keep the synchronous O(V^3) build from running away on a
  // complex coastline (which would freeze the server).
  const tol = Math.max(clearanceDeg * 0.5, 1e-7)
  obstacles = obstacles.map((poly) => [simplifyPath(outerRing(poly), tol)])
  const totalV = obstacles.reduce((s, p) => s + p[0].length, 0)
  if (totalV > LIMITS.maxObstacleVertices) {
    throw complexityError(
      'This segment crosses too much land or coastline to auto-route. Move the ' +
        'start or end toward open water, or add via-points to split it into ' +
        'shorter legs.'
    )
  }

  const graph = buildVisibilityGraph(a, b, obstacles, clearanceDeg)
  // start = node 0, end = node 1 (visibility.collectNodes contract).
  const path = astar(graph, 0, 1)
  if (!path) return null

  let via = path.slice(1, -1).map((i) => [graph.nodes[i][0], graph.nodes[i][1]])

  if (opts.simplify && via.length > 1) {
    // Simplify the full a→via→b chain, then strip the endpoints back off.
    const chain = [a, ...via, b]
    const tol = clearanceDeg * 0.25
    const simplified = simplifyPath(chain, tol)
    via = simplified.slice(1, -1)
  }

  if (via.length > opts.maxViaPoints) {
    via = capVia(a, b, via, opts.maxViaPoints)
  }
  return via
}

/**
 * Cap the via-point count by keeping the most "significant" vertices
 * (largest perpendicular deviation from the a→b chord). Guards against a
 * pathological coastline producing an unusable number of points.
 */
function capVia(a, b, via, cap) {
  if (via.length <= cap) return via
  const scored = via.map((p, i) => ({ p, i, d: perpDistance(p, a, b) }))
  scored.sort((x, y) => y.d - x.d)
  const keep = scored.slice(0, cap).sort((x, y) => x.i - y.i)
  return keep.map((s) => s.p)
}

/**
 * expandRoute(points, landPolygons, params) → expanded RoutePoint[]
 *
 * For each consecutive segment:
 *   - clear segment ⇒ kept byte-for-byte (original objects preserved);
 *   - crossing segment ⇒ a detour is computed and the intermediate via-points
 *     are spliced in as new { position } points between the two endpoints.
 *
 * Original points are never mutated or dropped. In 'fix-segments' mode only
 * crossing segments are altered; 'full' mode currently behaves the same (it
 * is reserved for a future whole-route re-optimisation pass).
 *
 * Returns { points, changed, segments } where `segments` reports per-segment
 * outcome (useful for tests and diagnostics). `clearance` in params is in
 * METRES; it is converted to degrees at the route's mean latitude.
 */
function expandRoute(points, landPolygons, params = {}) {
  const opts = { ...DEFAULTS, ...params }
  if (!Array.isArray(points) || points.length < 2) {
    return { points: points ? points.slice() : [], changed: false, segments: [] }
  }
  const polygons = Array.isArray(landPolygons) ? landPolygons : []

  // Mean latitude for the metres→degrees clearance conversion.
  const meanLat =
    points.reduce((s, p) => s + p.position[1], 0) / points.length
  const clearanceDeg = metresToDegrees(Math.max(0, opts.clearance), meanLat)

  const out = [points[0]]
  const segments = []
  let changed = false

  for (let i = 0; i < points.length - 1; i++) {
    const a = pos(points[i])
    const b = pos(points[i + 1])

    if (polygons.length === 0 || !segmentCrossesAny(a, b, polygons)) {
      out.push(points[i + 1])
      segments.push({ index: i, crossed: false, via: 0 })
      continue
    }

    const via = detour(a, b, polygons, clearanceDeg, opts)
    if (via === null || via.length === 0) {
      // No usable detour found — keep the original segment unchanged rather
      // than fabricate one. The caller/panel still shows the safety caveat.
      out.push(points[i + 1])
      segments.push({ index: i, crossed: true, via: 0, unresolved: true })
      continue
    }

    for (const v of via) {
      out.push({ position: [v[0], v[1]] })
    }
    out.push(points[i + 1])
    segments.push({ index: i, crossed: true, via: via.length })
    changed = true
  }

  return { points: out, changed, segments }
}

module.exports = {
  expandRoute,
  detour,
  simplifyPath,
  relevantPolygons,
  metresToDegrees,
  DEFAULTS,
  LIMITS
}
