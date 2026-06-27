// REST endpoint handler tests (transport-agnostic core, no Express needed).

'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const { handleRouteRequest, sanitiseParams } = require('../plugin/route-endpoint')

const P = (lon, lat) => ({ position: [lon, lat] })

test('bad input: not an object → 400', async () => {
  const res = await handleRouteRequest(null)
  assert.strictEqual(res.status, 400)
  assert.strictEqual(res.body.error, 'bad-request')
})

test('bad input: fewer than two points → 400', async () => {
  const res = await handleRouteRequest({ points: [P(0, 0)] })
  assert.strictEqual(res.status, 400)
})

test('bad input: non-numeric position → 400', async () => {
  const res = await handleRouteRequest({
    points: [P(0, 0), { position: ['x', 1] }]
  })
  assert.strictEqual(res.status, 400)
})

test('no covering chart → 422 land-source/none', async () => {
  // extraPaths empty + non-existent chartDir ⇒ no charts discovered.
  const res = await handleRouteRequest(
    { points: [P(0, 0), P(0.01, 0.01)] },
    { chartDir: '/nonexistent/path/charts', extraPaths: [] }
  )
  assert.strictEqual(res.status, 422)
  assert.strictEqual(res.body.error, 'land-source/none')
})

test('valid input with no charts still never crashes; returns a structured error', async () => {
  const res = await handleRouteRequest(
    { points: [P(0, 0), P(0.01, 0.01)], params: { clearance: 100 } },
    {}
  )
  assert.ok(res.status === 422 || res.status === 200)
  assert.ok(res.body)
})

test('sanitiseParams clamps and validates', () => {
  const p = sanitiseParams({
    clearance: -5,
    mode: 'bogus',
    simplify: 'yes',
    maxViaPoints: 9999
  })
  // negative clearance rejected → falls back to default
  assert.ok(p.clearance >= 0)
  // bogus mode rejected → default
  assert.ok(p.mode === 'fix-segments' || p.mode === 'full')
  // non-boolean simplify ignored → default boolean
  assert.strictEqual(typeof p.simplify, 'boolean')
  // maxViaPoints clamped to 500
  assert.ok(p.maxViaPoints <= 500)
})

test('runaway guard: continental-scale route span → 422 route-too-large', async () => {
  const res = await handleRouteRequest({ points: [P(0, 0), P(3, 3)] })
  assert.strictEqual(res.status, 422)
  assert.strictEqual(res.body.error, 'route-too-large')
})
