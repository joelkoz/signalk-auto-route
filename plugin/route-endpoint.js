// POST /plotterext/signalk-auto-route/route
//
// Same-origin REST endpoint the panel calls within the user's authenticated
// session. Body: { points: RoutePoint[], params?: {clearance?, mode?,
// simplify?, maxViaPoints?} }. Validates, computes the bbox, sources land
// polygons, runs the pure expandRoute engine, and returns the expanded points.
//
// Error contract:
//   400 { error:'bad-request', message }  — malformed/insufficient input
//   422 { error:'land-source/none', message } — no covering vector chart
//   500 { error:'internal', message } — unexpected (never crashes the server)
//
// This handler is wrapped in try/catch end to end so a thrown error in the
// engine or land source can never take down the Signal K process.

'use strict'

const { expandRoute, DEFAULTS } = require('../engine/route')
const { bbox } = require('../engine/geometry')
const { getLandPolygons, NoLandSourceError } = require('../engine/land-source')

// Coarse early reject: a route bounding box wider/taller than this (degrees) is
// a continental-scale request, not a local leg around nearby land. Rejecting
// here avoids reading a huge tile range before the per-segment guards engage.
const MAX_ROUTE_SPAN_DEG = 1.5

function isFinitePair(p) {
  return (
    Array.isArray(p) &&
    p.length >= 2 &&
    Number.isFinite(p[0]) &&
    Number.isFinite(p[1])
  )
}

/** Validate and normalise the request body. Throws { status, body } on error. */
function parseBody(body) {
  if (!body || typeof body !== 'object') {
    throw httpError(400, 'bad-request', 'Request body must be a JSON object.')
  }
  const { points, params } = body
  if (!Array.isArray(points) || points.length < 2) {
    throw httpError(
      400,
      'bad-request',
      'Provide a route with at least two points.'
    )
  }
  for (const pt of points) {
    if (!pt || !isFinitePair(pt.position)) {
      throw httpError(
        400,
        'bad-request',
        'Each point must have a numeric position [lon, lat].'
      )
    }
  }
  return { points, params: sanitiseParams(params) }
}

function sanitiseParams(params) {
  const p = params && typeof params === 'object' ? params : {}
  const out = { ...DEFAULTS }
  if (Number.isFinite(p.clearance) && p.clearance >= 0) out.clearance = p.clearance
  if (p.mode === 'full' || p.mode === 'fix-segments') out.mode = p.mode
  if (typeof p.simplify === 'boolean') out.simplify = p.simplify
  if (Number.isInteger(p.maxViaPoints) && p.maxViaPoints > 0) {
    out.maxViaPoints = Math.min(p.maxViaPoints, 500)
  }
  return out
}

function httpError(status, error, message) {
  return { status, body: { error, message } }
}

/**
 * Core handler, transport-agnostic for testability. Returns { status, body }.
 * `landSourceOptions` is merged into getLandPolygons (chartDir, extraPaths,
 * layerName, padDeg). Never throws.
 */
async function handleRouteRequest(body, landSourceOptions = {}) {
  try {
    const { points, params } = parseBody(body)
    const positions = points.map((p) => [p.position[0], p.position[1]])
    const routeBbox = bbox(positions)

    if (
      routeBbox[2] - routeBbox[0] > MAX_ROUTE_SPAN_DEG ||
      routeBbox[3] - routeBbox[1] > MAX_ROUTE_SPAN_DEG
    ) {
      throw httpError(
        422,
        'route-too-large',
        'This route spans too large an area to auto-route. Auto-routing is for ' +
          'local legs around nearby land, not long passages.'
      )
    }

    let land
    try {
      land = getLandPolygons(routeBbox, landSourceOptions)
    } catch (err) {
      // NoLandSourceError (land-source/none) and the tile-cap guard
      // (area-too-large) both carry a typed reason → friendly 422.
      if (err instanceof NoLandSourceError || (err && err.reason)) {
        return httpError(422, err.reason, err.message)
      }
      // Unexpected land-source failure (e.g. missing decode deps, bad file):
      // surface as 500 but keep the server alive.
      return httpError(
        500,
        'internal',
        `Land source failed: ${err.message}`
      )
    }

    const result = expandRoute(points, land.polygons, params)
    return {
      status: 200,
      body: {
        points: result.points,
        changed: result.changed,
        segments: result.segments,
        source: land.source
      }
    }
  } catch (err) {
    if (err && err.status && err.body) return err // validation/limit httpError
    // Typed engine error (e.g. route-too-complex from expandRoute) → 422.
    if (err && err.reason) {
      return httpError(422, err.reason, err.message)
    }
    return httpError(500, 'internal', `Unexpected error: ${err.message}`)
  }
}

/**
 * Express handler factory. `getOptions()` returns the live land-source options
 * (chartDir from plugin config, etc.) at request time.
 */
function makeExpressHandler(getOptions) {
  return async (req, res) => {
    const { status, body } = await handleRouteRequest(
      req.body,
      getOptions ? getOptions() : {}
    )
    res.status(status).json(body)
  }
}

module.exports = { handleRouteRequest, makeExpressHandler, parseBody, sanitiseParams }
