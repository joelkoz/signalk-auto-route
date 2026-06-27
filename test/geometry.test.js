'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const {
  distance,
  segmentsIntersect,
  pointInPolygon,
  segmentCrossesPolygon,
  segmentCrossesAny,
  offsetRing,
  signedArea
} = require('../engine/geometry')

// A unit square island centred at the origin, CCW.
const square = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1]
]

test('distance is planar Euclidean', () => {
  assert.strictEqual(distance([0, 0], [3, 4]), 5)
})

test('segmentsIntersect: crossing vs non-crossing', () => {
  assert.ok(segmentsIntersect([-2, 0], [2, 0], [0, -2], [0, 2]))
  assert.ok(!segmentsIntersect([0, 0], [1, 0], [0, 1], [1, 1]))
})

test('segmentsIntersect: collinear touching endpoint', () => {
  assert.ok(segmentsIntersect([0, 0], [2, 0], [2, 0], [4, 0]))
})

test('pointInPolygon: inside / outside', () => {
  assert.ok(pointInPolygon([0, 0], square))
  assert.ok(!pointInPolygon([5, 5], square))
})

test('pointInPolygon: on-edge counts as inside', () => {
  assert.ok(pointInPolygon([1, 0], square))
})

test('segmentCrossesPolygon: straight line through island crosses', () => {
  assert.ok(segmentCrossesPolygon([-3, 0], [3, 0], square))
})

test('segmentCrossesPolygon: line clear of island does not cross', () => {
  assert.ok(!segmentCrossesPolygon([-3, 3], [3, 3], square))
})

test('segmentCrossesPolygon: segment fully inside crosses', () => {
  assert.ok(segmentCrossesPolygon([-0.5, 0], [0.5, 0], square))
})

test('segmentCrossesAny across multiple polygons', () => {
  const far = [
    [10, 10],
    [11, 10],
    [11, 11],
    [10, 11]
  ]
  assert.ok(segmentCrossesAny([-3, 0], [3, 0], [far, square]))
  assert.ok(!segmentCrossesAny([-3, 5], [3, 5], [far, square]))
})

test('signedArea positive for CCW ring', () => {
  assert.ok(signedArea(square) > 0)
})

test('offsetRing pushes vertices outward by ~d', () => {
  const off = offsetRing(square, 0.5)
  // Every offset vertex should be farther from origin than the original.
  for (let i = 0; i < square.length; i++) {
    assert.ok(distance([0, 0], off[i]) > distance([0, 0], square[i]))
  }
  // A point that was outside at 1.4 stays outside; the offset ring should
  // now contain a point just beyond the original corner.
  assert.ok(pointInPolygon([1.2, 1.2], off))
})
