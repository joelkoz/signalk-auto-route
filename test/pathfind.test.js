'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const { buildVisibilityGraph } = require('../engine/visibility')
const { astar } = require('../engine/pathfind')
const { segmentEntersPolygon, distance } = require('../engine/geometry')

const square = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1]
]

test('visibility graph: start/end are nodes 0 and 1', () => {
  const start = [-3, 0]
  const end = [3, 0]
  const g = buildVisibilityGraph(start, end, [square], 0)
  assert.deepStrictEqual(g.nodes[0], start)
  assert.deepStrictEqual(g.nodes[1], end)
  assert.ok(g.nodes.length >= 6) // 2 endpoints + 4 square vertices
})

test('start and end are NOT directly visible through the island', () => {
  const g = buildVisibilityGraph([-3, 0], [3, 0], [square], 0)
  const direct = g.adj[0].some((e) => e.to === 1)
  assert.ok(!direct)
})

test('A* finds a path around the island that avoids land', () => {
  const start = [-3, 0]
  const end = [3, 0]
  const g = buildVisibilityGraph(start, end, [square], 0)
  const path = astar(g, 0, 1)
  assert.ok(path, 'path should exist')
  assert.strictEqual(path[0], 0)
  assert.strictEqual(path[path.length - 1], 1)

  // Every leg of the resulting poly-line must clear the island's interior.
  // (With zero clearance the optimal path legitimately touches the corner
  // vertices, so the interior test — not the boundary-touch test — applies.)
  const pts = path.map((i) => g.nodes[i])
  for (let i = 0; i < pts.length - 1; i++) {
    assert.ok(
      !segmentEntersPolygon(pts[i], pts[i + 1], square),
      `leg ${i} crosses the island`
    )
  }
})

test('A* returns a near-optimal detour length', () => {
  const start = [-3, 0]
  const end = [3, 0]
  const g = buildVisibilityGraph(start, end, [square], 0)
  const path = astar(g, 0, 1)
  const pts = path.map((i) => g.nodes[i])
  let len = 0
  for (let i = 0; i < pts.length - 1; i++) len += distance(pts[i], pts[i + 1])
  // Straight line would be 6; going around a unit square is modestly longer.
  assert.ok(len > 6 && len < 8, `detour length ${len} unreasonable`)
})

test('A* returns null when goal unreachable (empty graph edges)', () => {
  // Two coincident endpoints surrounded by nothing → trivially the same node
  // index 0/1; instead simulate unreachable by a disconnected graph.
  const g = { nodes: [[0, 0], [10, 10]], adj: [[], []] }
  assert.strictEqual(astar(g, 0, 1), null)
})
