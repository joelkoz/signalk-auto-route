'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const { expandRoute } = require('../engine/route')
const { segmentCrossesAny } = require('../engine/geometry')

// A square island ~0.02° across centred near the route line. Coordinates are
// realistic lon/lat so the metres→degrees clearance conversion exercises real
// numbers.
const island = [
  [-0.01, -0.01],
  [0.01, -0.01],
  [0.01, 0.01],
  [-0.01, 0.01]
]

const P = (lon, lat, extra = {}) => ({ position: [lon, lat], ...extra })

function asLonLat(points) {
  return points.map((p) => [p.position[0], p.position[1]])
}

test('clear 2-point route is returned unchanged', () => {
  const route = [P(-0.05, 0.05), P(0.05, 0.05)] // passes north of island
  const { points, changed } = expandRoute(route, [island], { clearance: 50 })
  assert.strictEqual(changed, false)
  assert.strictEqual(points.length, 2)
  // Original objects preserved by identity.
  assert.strictEqual(points[0], route[0])
  assert.strictEqual(points[1], route[1])
})

test('2-point route across island is rerouted and avoids land', () => {
  const route = [P(-0.05, 0), P(0.05, 0)] // straight through the island
  const { points, changed, segments } = expandRoute(route, [island], {
    clearance: 50
  })
  assert.ok(changed)
  assert.ok(points.length > 2, 'via-points were inserted')
  assert.strictEqual(segments[0].crossed, true)

  // Endpoints preserved exactly.
  assert.deepStrictEqual(points[0].position, [-0.05, 0])
  assert.deepStrictEqual(points[points.length - 1].position, [0.05, 0])

  // No leg of the expanded route crosses the island.
  const ll = asLonLat(points)
  for (let i = 0; i < ll.length - 1; i++) {
    assert.ok(
      !segmentCrossesAny(ll[i], ll[i + 1], [island]),
      `expanded leg ${i} still crosses land`
    )
  }
})

test('fix-segments: clear segments stay byte-identical, only crossing fixed', () => {
  // 3 points: leg 0 clear (north), leg 1 crosses the island.
  const route = [P(-0.05, 0.05), P(-0.05, 0), P(0.05, 0)]
  const { points, segments } = expandRoute(route, [island], { clearance: 50 })

  assert.strictEqual(segments[0].crossed, false)
  assert.strictEqual(segments[1].crossed, true)

  // The three original points must all still be present by identity.
  assert.ok(points.includes(route[0]))
  assert.ok(points.includes(route[1]))
  assert.ok(points.includes(route[2]))

  // First two output points are the untouched leg-0 endpoints.
  assert.strictEqual(points[0], route[0])
  assert.strictEqual(points[1], route[1])
})

test('user via-points are preserved in order', () => {
  const route = [
    P(-0.05, 0.05, { name: 'A' }),
    P(0, 0.05, { name: 'mid' }),
    P(0.05, 0.05, { name: 'B' })
  ]
  const { points, changed } = expandRoute(route, [island], { clearance: 50 })
  assert.strictEqual(changed, false)
  assert.deepStrictEqual(
    points.map((p) => p.name),
    ['A', 'mid', 'B']
  )
})

test('clearance is respected (larger clearance pushes route further out)', () => {
  const route = [P(-0.05, 0), P(0.05, 0)]
  const small = expandRoute(route, [island], { clearance: 50 })
  const large = expandRoute(route, [island], { clearance: 500 })

  const maxAbsLat = (res) =>
    Math.max(...res.points.map((p) => Math.abs(p.position[1])))

  // Both must still clear the island.
  for (const res of [small, large]) {
    const ll = asLonLat(res.points)
    for (let i = 0; i < ll.length - 1; i++) {
      assert.ok(!segmentCrossesAny(ll[i], ll[i + 1], [island]))
    }
  }
  // A larger clearance should detour at least as far from the centre line.
  assert.ok(maxAbsLat(large) >= maxAbsLat(small))
})

test('maxViaPoints cap is honoured', () => {
  // A jagged coastline with many vertices between the endpoints.
  const teeth = []
  for (let i = 0; i <= 20; i++) {
    const x = -0.02 + (i * 0.04) / 20
    teeth.push([x, i % 2 === 0 ? -0.005 : 0.005])
  }
  // Close it into a polygon along the bottom.
  const jagged = [...teeth, [0.02, -0.02], [-0.02, -0.02]]
  const route = [P(-0.05, 0), P(0.05, 0)]
  const { points, segments } = expandRoute(route, [jagged], {
    clearance: 50,
    maxViaPoints: 3,
    simplify: false
  })
  assert.ok(segments[0].via <= 3, `via count ${segments[0].via} exceeds cap`)
  // endpoints + at most 3 via = at most 5.
  assert.ok(points.length <= 5)
})

test('no land polygons ⇒ route unchanged', () => {
  const route = [P(-0.05, 0), P(0.05, 0)]
  const { points, changed } = expandRoute(route, [], { clearance: 50 })
  assert.strictEqual(changed, false)
  assert.strictEqual(points.length, 2)
})

test('single-point or empty input is returned safely', () => {
  assert.deepStrictEqual(expandRoute([], [island]).points, [])
  const one = [P(0, 0)]
  assert.strictEqual(expandRoute(one, [island]).points.length, 1)
})
