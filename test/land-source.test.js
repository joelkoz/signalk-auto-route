// Land-source tests that need NO external decode deps or chart fixtures —
// they exercise the pure helpers (tile-local→lon/lat conversion, bbox
// padding, discovery on a non-existent dir). MVT decode + real MBTiles reads
// are covered by manual/integration testing against a fixture chart (see
// REQUIREMENTS.md test plan) because @mapbox/vector-tile + pbf are not
// installed in the offline unit-test environment.

'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const {
  tileLocalToLonLat,
  padBbox,
  discoverCharts
} = require('../engine/land-source')

test('padBbox expands on all sides', () => {
  assert.deepStrictEqual(padBbox([0, 0, 1, 1], 0.5), [-0.5, -0.5, 1.5, 1.5])
})

test('tileLocalToLonLat maps tile corners to tile geographic edges', () => {
  // Tile (z=0, x=0, y=0) covers the whole world in Web Mercator.
  const nw = tileLocalToLonLat(0, 0, 0, 0, 0)
  const se = tileLocalToLonLat(4096, 4096, 0, 0, 0)
  assert.ok(Math.abs(nw[0] - -180) < 1e-6, 'west edge ≈ -180')
  assert.ok(Math.abs(se[0] - 180) < 1e-6, 'east edge ≈ 180')
  assert.ok(nw[1] > 85 && nw[1] < 86, 'north edge ≈ +85.05')
  assert.ok(se[1] < -85 && se[1] > -86, 'south edge ≈ -85.05')
})

test('discoverCharts returns empty for a non-existent directory', () => {
  const files = discoverCharts({ chartDir: '/no/such/dir', extraPaths: [] })
  assert.deepStrictEqual(files, [])
})

test('discoverCharts scans every candidate dir in chartDirs', () => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'autoroute-charts-'))
  const simple = path.join(base, 'charts-simple')
  fs.mkdirSync(simple)
  const file = path.join(simple, 'FL-Keys.mbtiles')
  fs.writeFileSync(file, 'x')
  try {
    // The plugin passes several candidates; only `charts-simple` has the file.
    const found = discoverCharts({
      chartDirs: [path.join(base, 'charts'), simple],
      extraPaths: []
    })
    assert.deepStrictEqual(found, [file])
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})
