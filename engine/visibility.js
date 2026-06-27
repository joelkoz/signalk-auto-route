// Visibility-graph construction for land-avoidance routing.
//
// ZERO external dependencies. Given a set of obstacle polygons and a set of
// candidate nodes (typically: the two segment endpoints + every obstacle
// vertex), build a graph whose edges connect node pairs that "see" each
// other — i.e. the straight segment between them does not pass through the
// interior of any obstacle. A* over this graph (pathfind.js) then yields the
// shortest land-avoiding poly-line.

'use strict'

const {
  distance,
  segmentEntersPolygon,
  outerRing,
  offsetRing
} = require('./geometry')

/**
 * Prepare obstacles for visibility: optionally offset each outer ring outward
 * by `clearance` (in the same units as the coordinates — degrees here) so the
 * graph keeps a safety margin off land. Returns an array of bare rings.
 */
function prepareObstacles(polygons, clearance = 0) {
  return polygons.map((poly) => {
    const ring = outerRing(poly)
    return clearance > 0 ? offsetRing(ring, clearance) : ring.map((p) => [p[0], p[1]])
  })
}

/**
 * Collect candidate graph nodes: the supplied endpoints first (so their
 * indices are stable and known to the caller: start = 0, end = 1), followed
 * by every vertex of every prepared obstacle ring.
 */
function collectNodes(start, end, obstacleRings) {
  const nodes = [start, end]
  for (const ring of obstacleRings) {
    for (const v of ring) nodes.push([v[0], v[1]])
  }
  return nodes
}

/**
 * Two nodes are mutually visible if the segment between them does not cross
 * the interior of any obstacle. The obstacle rings are tested directly (they
 * are already offset by clearance). A segment that merely grazes a vertex is
 * allowed; one that passes through interior or crosses an edge is blocked.
 */
function visible(a, b, obstacleRings) {
  for (const ring of obstacleRings) {
    if (segmentEntersPolygon(a, b, ring)) return false
  }
  return true
}

/**
 * Build the visibility graph. Returns:
 *   { nodes: [[lon,lat],...], adj: [[{to, w}, ...], ...] }
 * where adj[i] lists visible neighbours of node i with edge weight w
 * (planar distance). Node 0 is `start`, node 1 is `end`.
 *
 * O(V^2 * E_obstacle): fine for the bbox-scoped vertex counts this router
 * works with (tens, occasionally low hundreds, of vertices).
 */
function buildVisibilityGraph(start, end, polygons, clearance = 0) {
  const obstacleRings = prepareObstacles(polygons, clearance)
  const nodes = collectNodes(start, end, obstacleRings)
  const n = nodes.length
  const adj = Array.from({ length: n }, () => [])

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (coincident(nodes[i], nodes[j])) continue
      if (visible(nodes[i], nodes[j], obstacleRings)) {
        const w = distance(nodes[i], nodes[j])
        adj[i].push({ to: j, w })
        adj[j].push({ to: i, w })
      }
    }
  }

  return { nodes, adj }
}

function coincident(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12
}

module.exports = {
  prepareObstacles,
  collectNodes,
  visible,
  buildVisibilityGraph
}
