// Pure planar geometry primitives for the land-avoidance router.
//
// ZERO external dependencies — every routine here is hand-rolled so the
// engine core unit-tests run offline with `node --test`.
//
// SIMPLIFICATION (documented): all distance/intersection math is treated as
// PLANAR in lon/lat degrees. A degree of longitude and a degree of latitude
// are NOT the same ground distance away from the equator, so absolute
// distances are only approximate and slightly distorted in the N–S vs E–W
// sense. This is intentional and acceptable for v1: the router only needs a
// *consistent* metric to choose the shorter of competing detours and to test
// segment/polygon crossings — both of which are scale-invariant. The
// `clearance` margin is converted from metres to degrees by the caller (see
// route.js) using a local metres-per-degree factor at the route's latitude,
// which restores correct ground scale for the one place it matters.
//
// A "ring" is an array of [lon, lat] vertices (the polygon is implicitly
// closed; the last vertex need not repeat the first). A "land polygon" is an
// array of rings: ring[0] is the outer boundary, ring[1..] are holes. v1 only
// uses the outer ring for obstacle math; holes are tolerated but ignored.

'use strict'

const EPS = 1e-12

/** Euclidean (planar) distance between two [lon,lat] points. */
function distance(a, b) {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  return Math.sqrt(dx * dx + dy * dy)
}

/** Squared distance — cheaper when only comparing. */
function distanceSq(a, b) {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  return dx * dx + dy * dy
}

/**
 * Orientation of the ordered triplet (p, q, r).
 *  >0 counter-clockwise, <0 clockwise, 0 collinear.
 */
function cross(p, q, r) {
  return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
}

/** True if point q lies on segment pr (assuming p,q,r collinear). */
function onSegment(p, q, r) {
  return (
    q[0] <= Math.max(p[0], r[0]) + EPS &&
    q[0] >= Math.min(p[0], r[0]) - EPS &&
    q[1] <= Math.max(p[1], r[1]) + EPS &&
    q[1] >= Math.min(p[1], r[1]) - EPS
  )
}

/**
 * Proper/improper segment intersection test for segments p1p2 and p3p4.
 * Returns true if the two closed segments share at least one point.
 */
function segmentsIntersect(p1, p2, p3, p4) {
  const d1 = cross(p3, p4, p1)
  const d2 = cross(p3, p4, p2)
  const d3 = cross(p1, p2, p3)
  const d4 = cross(p1, p2, p4)

  if (
    ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
    ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))
  ) {
    return true
  }

  if (Math.abs(d1) <= EPS && onSegment(p3, p1, p4)) return true
  if (Math.abs(d2) <= EPS && onSegment(p3, p2, p4)) return true
  if (Math.abs(d3) <= EPS && onSegment(p1, p3, p2)) return true
  if (Math.abs(d4) <= EPS && onSegment(p1, p4, p2)) return true

  return false
}

/** Outer ring of a land polygon (array-of-rings or a bare ring). */
function outerRing(poly) {
  if (!Array.isArray(poly) || poly.length === 0) return []
  // Bare ring: first element is a [lon,lat] pair (two numbers).
  if (typeof poly[0][0] === 'number') return poly
  return poly[0]
}

/**
 * Point-in-polygon by ray casting against the outer ring.
 * Points exactly on an edge are reported as inside (conservative for an
 * obstacle test — we'd rather treat a boundary touch as a crossing).
 */
function pointInPolygon(point, poly) {
  const ring = outerRing(poly)
  const n = ring.length
  if (n < 3) return false
  const x = point[0]
  const y = point[1]
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]

    // On-edge → inside.
    if (Math.abs(cross(ring[j], ring[i], point)) <= EPS && onSegment(ring[j], point, ring[i])) {
      return true
    }

    const intersects =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

/**
 * Does segment ab cross the polygon's interior?
 *
 * True if the segment intersects any edge of the outer ring, OR if the
 * segment's midpoint lies strictly inside (covers a segment fully contained
 * in the polygon with no edge crossing). Endpoints that merely touch a vertex
 * or edge without entering the interior are handled by the midpoint check.
 */
function segmentCrossesPolygon(a, b, poly) {
  const ring = outerRing(poly)
  const n = ring.length
  if (n < 3) return false

  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (segmentsIntersect(a, b, ring[j], ring[i])) {
      return true
    }
  }
  // No edge crossing: segment is either entirely outside or entirely inside.
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  return pointInPolygon(mid, poly)
}

/**
 * Properly-intersecting segments: the two segments cross at a single point
 * interior to BOTH (no endpoint-touch, no collinear overlap). This is the
 * test a visibility graph needs — a segment running along a polygon edge or
 * touching a vertex must NOT be considered blocked.
 */
function segmentsProperlyIntersect(p1, p2, p3, p4) {
  const d1 = cross(p3, p4, p1)
  const d2 = cross(p3, p4, p2)
  const d3 = cross(p1, p2, p3)
  const d4 = cross(p1, p2, p4)
  return (
    ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
    ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))
  )
}

/**
 * Does segment ab pass through the INTERIOR of the polygon? Unlike
 * segmentCrossesPolygon, a segment that merely runs along an edge or touches a
 * vertex is allowed (returns false). This is the visibility-graph test.
 *
 * Blocked when: (a) ab properly crosses any ring edge, or (b) the segment's
 * midpoint — or any sampled interior point not coincident with a vertex —
 * lies strictly inside the ring. Sampling a few interior points guards the
 * case where ab enters and exits through two vertices of a concave ring.
 */
function segmentEntersPolygon(a, b, poly) {
  const ring = outerRing(poly)
  const n = ring.length
  if (n < 3) return false

  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (segmentsProperlyIntersect(a, b, ring[j], ring[i])) return true
  }

  // Sample interior points along the segment; if a sample is strictly inside
  // (not on the boundary), the segment passes through land.
  const SAMPLES = 8
  for (let k = 1; k < SAMPLES; k++) {
    const t = k / SAMPLES
    const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    if (strictlyInside(p, ring)) return true
  }
  return false
}

/** Point strictly inside the ring (ray cast; on-edge ⇒ false). */
function strictlyInside(point, ring) {
  const n = ring.length
  if (n < 3) return false
  // On-boundary → not strictly inside.
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if (
      Math.abs(cross(ring[j], ring[i], point)) <= EPS &&
      onSegment(ring[j], point, ring[i])
    ) {
      return false
    }
  }
  const x = point[0]
  const y = point[1]
  let inside = false
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

/** True if segment ab crosses ANY polygon in the list. */
function segmentCrossesAny(a, b, polygons) {
  for (const poly of polygons) {
    if (segmentCrossesPolygon(a, b, poly)) return true
  }
  return false
}

/**
 * Signed area of a ring (shoelace). Positive ⇒ counter-clockwise winding.
 */
function signedArea(ring) {
  let area = 0
  const n = ring.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1])
  }
  return area / 2
}

/**
 * Offset (dilate) a ring outward by `d` along each vertex's angle bisector.
 * A small, dependency-free approximation of a polygon buffer: it pushes every
 * vertex away from the polygon centroid-relative interior along the bisector
 * of its two incident edges. Good enough to seed visibility-graph nodes that
 * sit a clearance margin off the coastline; it is NOT a true Minkowski buffer
 * (sharp concave corners can self-intersect for large `d`), which is fine for
 * the modest clearances this router uses.
 */
function offsetRing(ring, d) {
  const n = ring.length
  if (n < 3 || d === 0) return ring.map((p) => [p[0], p[1]])

  // Ensure counter-clockwise so the outward normal is consistent.
  let r = ring
  if (signedArea(ring) < 0) {
    r = ring.slice().reverse()
  }

  const out = []
  for (let i = 0; i < n; i++) {
    const prev = r[(i - 1 + n) % n]
    const curr = r[i]
    const next = r[(i + 1) % n]

    // Outward normals of the two incident edges (CCW ring ⇒ outward is the
    // right-hand normal of the forward edge direction).
    const n1 = edgeOutwardNormal(prev, curr)
    const n2 = edgeOutwardNormal(curr, next)
    let bx = n1[0] + n2[0]
    let by = n1[1] + n2[1]
    const len = Math.sqrt(bx * bx + by * by)
    if (len < EPS) {
      bx = n2[0]
      by = n2[1]
    } else {
      bx /= len
      by /= len
    }
    // Scale so the offset edge sits ~d away even at sharp corners.
    const cosHalf = Math.max(0.2, (n1[0] * bx + n1[1] * by))
    const scale = d / cosHalf
    out.push([curr[0] + bx * scale, curr[1] + by * scale])
  }
  return out
}

/** Outward (right-hand) unit normal of directed edge a→b on a CCW ring. */
function edgeOutwardNormal(a, b) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len < EPS) return [0, 0]
  // Right-hand normal of (dx,dy) is (dy,-dx); for a CCW ring that points out.
  return [dy / len, -dx / len]
}

/** Axis-aligned bounding box [minLon,minLat,maxLon,maxLat] of points. */
function bbox(points) {
  let minLon = Infinity
  let minLat = Infinity
  let maxLon = -Infinity
  let maxLat = -Infinity
  for (const p of points) {
    if (p[0] < minLon) minLon = p[0]
    if (p[0] > maxLon) maxLon = p[0]
    if (p[1] < minLat) minLat = p[1]
    if (p[1] > maxLat) maxLat = p[1]
  }
  return [minLon, minLat, maxLon, maxLat]
}

module.exports = {
  EPS,
  distance,
  distanceSq,
  cross,
  segmentsIntersect,
  segmentsProperlyIntersect,
  pointInPolygon,
  segmentCrossesPolygon,
  segmentEntersPolygon,
  segmentCrossesAny,
  signedArea,
  offsetRing,
  outerRing,
  bbox
}
