// Land-source adapter: discover the user's installed vector charts and pull
// LNDARE (land area) polygons covering a route's bounding box.
//
// This file is the ONE part of the engine that touches the outside world
// (the file system, node:sqlite, and the MVT decode deps). It is deliberately
// isolated from the pure-core geometry so the core stays offline-testable.
//
// Decode deps (declared in package.json, only loaded when actually reading a
// chart): @mapbox/vector-tile + pbf. They are required lazily so that:
//   - the pure-core unit tests never touch them, and
//   - a server missing them still loads the plugin (we surface a typed error).
//
// MBTiles read pattern mirrors signalk-charts-provider-simple's
// MBTilesReader (node:sqlite, readOnly; metadata.json → vector_layers; tiles
// gzipped pbf; XYZ→TMS row flip).
//
// TODO (v1 approximation): tile-edge polygon stitching is NOT performed. Land
// polygons clipped at tile borders are returned as separate fragments. For
// the visibility-graph router this is usually adequate (the fragments still
// block the offending segment), but a landmass split across a tile seam can
// leave a thin gap the router may thread. A proper fix unions adjacent-tile
// LNDARE fragments (turf.union / buffer(0)) before handing them to the engine.

'use strict'

const path = require('node:path')
const fs = require('node:fs')
const zlib = require('node:zlib')

const { LRUCache } = require('./cache')

const TILE_EXTENT = 4096
const DEFAULT_LAND_LAYER = 'LNDARE'

// Cap the number of tiles read for one route bbox. A continental-scale request
// ("around Europe") would otherwise try to read millions of tiles and hang.
const MAX_TILES = 4096

// Stitched-polygon cache keyed by `${file}|${mtimeMs}|${z}|${bboxQuant}`.
const polygonCache = new LRUCache(24)

class NoLandSourceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NoLandSourceError'
    this.reason = 'land-source/none'
  }
}

// ---- node:sqlite reader (subset of charts-provider-simple's reader) --------

function openDb(filePath) {
  // node:sqlite is built in on Node >= 22.5 (no native compile).
  const { DatabaseSync } = require('node:sqlite')
  return new DatabaseSync(filePath, { readOnly: true })
}

function readMetadata(db) {
  const rows = db.prepare('SELECT name, value FROM metadata').all()
  const meta = {}
  for (const { name, value } of rows) {
    if (name === 'bounds' || name === 'center') {
      meta[name] = String(value).split(',').map(Number)
    } else if (name === 'minzoom' || name === 'maxzoom') {
      meta[name] = parseInt(value, 10)
    } else if (name === 'json') {
      try {
        const parsed = JSON.parse(value)
        if (parsed && Array.isArray(parsed.vector_layers)) {
          meta.vector_layers = parsed.vector_layers
        }
      } catch {
        /* ignore */
      }
    } else if (name === 'vector_layers') {
      try {
        meta.vector_layers = JSON.parse(value)
      } catch {
        /* ignore */
      }
    } else {
      meta[name] = value
    }
  }
  return meta
}

function getTile(db, z, x, y) {
  const tmsY = (1 << z) - 1 - y
  const row = db
    .prepare(
      'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?'
    )
    .get(z, x, tmsY)
  if (!row || !row.tile_data) return null
  const u = row.tile_data
  return Buffer.from(u.buffer, u.byteOffset, u.byteLength)
}

// ---- slippy-tile math ------------------------------------------------------

function lon2tile(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z)
}

function lat2tile(lat, z) {
  const rad = (lat * Math.PI) / 180
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z
  )
}

function tile2lon(x, z) {
  return (x / 2 ** z) * 360 - 180
}

function tile2lat(y, z) {
  const nn = Math.PI - (2 * Math.PI * y) / 2 ** z
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(nn) - Math.exp(-nn)))
}

/** Tile-local (extent 4096) coords → [lon,lat] for tile (z,x,y). */
function tileLocalToLonLat(px, py, z, x, y) {
  const west = tile2lon(x, z)
  const east = tile2lon(x + 1, z)
  const north = tile2lat(y, z)
  const south = tile2lat(y + 1, z)
  const lon = west + (px / TILE_EXTENT) * (east - west)
  const lat = north + (py / TILE_EXTENT) * (south - north)
  return [lon, lat]
}

// ---- chart discovery -------------------------------------------------------

/**
 * Discover candidate MBTiles files. Best-effort and dependency-light:
 *   1. If `app` exposes a charts resource API, read it and keep file paths.
 *   2. Otherwise (or in addition) scan `chartDir` for *.mbtiles.
 * Returns an array of absolute file paths (deduplicated).
 */
function discoverCharts({ chartDir, chartDirs, extraPaths } = {}) {
  const found = new Set()
  for (const p of extraPaths || []) {
    if (p && fs.existsSync(p)) found.add(path.resolve(p))
  }
  // Accept either a single chartDir or a list of candidate dirs (the plugin
  // passes several, since chart providers use different folder names, e.g.
  // charts-provider-simple writes to `charts-simple`).
  const dirs = [...(chartDirs || []), chartDir].filter(Boolean)
  for (const dir of dirs) {
    if (fs.existsSync(dir)) walkForMbtiles(dir, found)
  }
  return [...found]
}

function walkForMbtiles(dir, out, depth = 0) {
  if (depth > 6) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      walkForMbtiles(full, out, depth + 1)
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.mbtiles')) {
      out.add(path.resolve(full))
    }
  }
}

function bboxOverlaps(a, b) {
  // a,b = [minLon,minLat,maxLon,maxLat]
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3])
}

function metaHasLandLayer(meta, layerName) {
  const layers = meta.vector_layers
  if (!Array.isArray(layers)) return false
  return layers.some((l) => l && l.id === layerName)
}

/**
 * Qualify a single MBTiles file against the route bbox:
 *   - vector (format === 'pbf'),
 *   - has the land layer in vector_layers,
 *   - bounds (if present) overlap the route bbox.
 * Returns { file, meta } or null.
 */
function qualifyChart(file, bbox, layerName) {
  let db
  try {
    db = openDb(file)
    const meta = readMetadata(db)
    if (meta.format !== 'pbf') return null
    if (!metaHasLandLayer(meta, layerName)) return null
    if (Array.isArray(meta.bounds) && meta.bounds.length === 4) {
      if (!bboxOverlaps(meta.bounds, bbox)) return null
    }
    return { file, meta }
  } catch {
    return null
  } finally {
    if (db) {
      try {
        db.close()
      } catch {
        /* ignore */
      }
    }
  }
}

// ---- MVT decode + LNDARE extraction ---------------------------------------

function decodeLandPolygonsFromTile(buf, z, x, y, layerName) {
  // Lazy-load decode deps so the pure core never pulls them in.
  let VectorTile
  let Pbf
  try {
    VectorTile = require('@mapbox/vector-tile').VectorTile
    // pbf v4 is ESM-only: require() yields the module namespace, so the Pbf
    // constructor is the default export (.default), not the namespace itself.
    const pbfModule = require('pbf')
    Pbf = pbfModule.default || pbfModule
  } catch (err) {
    const e = new Error(
      'auto-route: @mapbox/vector-tile and pbf are required to read vector charts'
    )
    e.cause = err
    throw e
  }

  let data = buf
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    data = zlib.gunzipSync(buf)
  }
  const tile = new VectorTile(new Pbf(data))
  const layer = tile.layers[layerName]
  if (!layer) return []

  const polygons = []
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i)
    // 3 === POLYGON in the MVT geometry-type enum.
    if (feature.type !== 3) continue
    const rings = feature.loadGeometry() // [[ {x,y}, ... ], ...]
    if (!rings.length) continue
    // Convert each ring; ring[0] is the outer boundary of this polygon part.
    const converted = rings.map((ring) =>
      ring.map((pt) => tileLocalToLonLat(pt.x, pt.y, z, x, y))
    )
    polygons.push(converted)
  }
  return polygons
}

/**
 * Pad a bbox by `padDeg` on every side.
 */
function padBbox(bbox, padDeg) {
  return [bbox[0] - padDeg, bbox[1] - padDeg, bbox[2] + padDeg, bbox[3] + padDeg]
}

/**
 * Read LNDARE polygons covering `bbox` from a qualified chart at its maxzoom.
 * Returns an array of land polygons (array-of-rings). Caches by file+mtime+
 * zoom+bbox so a repeat call in the same waters reuses the obstacle set.
 */
function readLandPolygons({ file, meta }, bbox, layerName) {
  const z = Number.isInteger(meta.maxzoom) ? meta.maxzoom : 14
  const stat = fs.statSync(file)
  const quant = bbox.map((v) => v.toFixed(3)).join(',')
  const key = `${file}|${stat.mtimeMs}|${z}|${quant}`
  const cached = polygonCache.get(key)
  if (cached) return cached

  const minX = lon2tile(bbox[0], z)
  const maxX = lon2tile(bbox[2], z)
  const minY = lat2tile(bbox[3], z) // north → smaller y
  const maxY = lat2tile(bbox[1], z)

  const tileCount = (maxX - minX + 1) * (maxY - minY + 1)
  if (tileCount > MAX_TILES) {
    throw Object.assign(
      new Error(
        `route area too large: ${tileCount} tiles at z${z} (max ${MAX_TILES})`
      ),
      { reason: 'area-too-large' }
    )
  }

  const polygons = []
  let db
  try {
    db = openDb(file)
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        const buf = getTile(db, z, x, y)
        if (!buf) continue
        const tilePolys = decodeLandPolygonsFromTile(buf, z, x, y, layerName)
        for (const p of tilePolys) polygons.push(p)
      }
    }
  } finally {
    if (db) {
      try {
        db.close()
      } catch {
        /* ignore */
      }
    }
  }

  polygonCache.set(key, polygons)
  return polygons
}

/**
 * Top-level: resolve land polygons for a route bbox.
 * Options: { chartDir, extraPaths, layerName=LNDARE, padDeg=0.02 }.
 * Throws NoLandSourceError if no qualifying vector chart covers the bbox.
 * Returns { polygons, source: file }.
 */
function getLandPolygons(bbox, opts = {}) {
  const layerName = opts.layerName || DEFAULT_LAND_LAYER
  const padDeg = typeof opts.padDeg === 'number' ? opts.padDeg : 0.02
  const padded = padBbox(bbox, padDeg)

  const files = discoverCharts(opts)
  if (files.length === 0) {
    throw new NoLandSourceError(
      'No charts found to source land data from. Install a vector (S-57/pbf) chart that covers this area.'
    )
  }

  for (const file of files) {
    const chart = qualifyChart(file, padded, layerName)
    if (!chart) continue
    const polygons = readLandPolygons(chart, padded, layerName)
    return { polygons, source: file }
  }

  throw new NoLandSourceError(
    `No vector chart with a "${layerName}" land layer covers this area. Install/enable a vector chart for these waters.`
  )
}

module.exports = {
  getLandPolygons,
  discoverCharts,
  qualifyChart,
  readLandPolygons,
  decodeLandPolygonsFromTile,
  tileLocalToLonLat,
  padBbox,
  NoLandSourceError,
  polygonCache,
  DEFAULT_LAND_LAYER
}
