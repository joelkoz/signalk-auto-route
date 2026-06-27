// signalk-auto-route
//
// Reference plotterExtensions extension exercising the `routes` capability:
// land-avoidance auto-routing over a host's live route edit buffer.
//
// The plugin has three responsibilities (see REQUIREMENTS.md / the spec):
//   1. Register a READ-ONLY plotterExtensions resource provider whose single
//      resource is this extension's manifest (keyed by the plugin id).
//   2. Serve the panel UI assets from a public top-level static route at
//      /plotterext/signalk-auto-route/ (NOT /plugins/* — that is admin-gated
//      and would break read-only users; NOT a signalk-webapp — these pages
//      only ever load inside a host iframe).
//   3. Mount a same-origin REST endpoint (POST /plotterext/signalk-auto-route/
//      route) that runs the server-side routing engine.
//
// The routing engine itself (engine/*) is pure and host-agnostic; this file is
// the only Signal-K-coupled layer.

'use strict'

const path = require('node:path')

const pkg = require('../package.json')
const { makeExpressHandler } = require('./route-endpoint')
const { DEFAULT_LAND_LAYER } = require('../engine/land-source')

const PLUGIN_ID = 'signalk-auto-route'
const ASSET_BASE = `/plotterext/${PLUGIN_ID}`
const PUBLIC_DIR = path.join(__dirname, '..', 'public')

function buildManifest() {
  return {
    name: 'Auto Route',
    description: 'Route around land between the points of a route.',
    version: pkg.version,
    apiVersion: '1',
    requires: ['buttons', 'panels.iframe', 'routes'],
    optional: ['map', 'units'],
    buttons: [
      {
        id: 'open-auto-route',
        title: 'Auto Route',
        slot: 'mapToolbar',
        icon: 'alt_route',
        action: { type: 'togglePanel', panel: 'auto-route-panel' }
      }
    ],
    panels: [
      {
        id: 'auto-route-panel',
        title: 'Auto Route',
        type: 'iframe',
        url: `${ASSET_BASE}/panel.html`,
        lifecycle: 'keepAlive'
      }
    ]
  }
}

module.exports = (app) => {
  let running = false
  let providerRegistered = false
  let assetsMounted = false
  let endpointMounted = false
  let options = {}

  const debug = (msg) => {
    if (typeof app.debug === 'function') app.debug(`${PLUGIN_ID}: ${msg}`)
  }
  const warn = (msg) => {
    // Recoverable feature-detection failures use console.warn, not error.
    if (typeof app.error === 'function') app.error(`${PLUGIN_ID}: ${msg}`)
    else console.warn(`${PLUGIN_ID}: ${msg}`)
  }

  // Land-source options resolved live at request time from plugin config +
  // the server's chart directories.
  const landSourceOptions = () => {
    return {
      chartDirs: chartDirCandidates(app, options),
      extraPaths: options.extraChartPaths || [],
      layerName: options.landLayer || DEFAULT_LAND_LAYER,
      padDeg:
        typeof options.bboxPadDeg === 'number' ? options.bboxPadDeg : 0.02
    }
  }

  // express is provided by the Signal K server, so requiring it adds no
  // runtime dependency of our own. Loaded lazily and guarded so the test
  // harness (a fake app, no express needed) and any server lacking it degrade
  // without throwing.
  const loadExpress = () => {
    try {
      return require('express')
    } catch {
      warn(`express unavailable; cannot serve ${ASSET_BASE}`)
      return null
    }
  }

  const mountAssets = () => {
    if (assetsMounted) return
    if (typeof app.use !== 'function') return
    const express = loadExpress()
    if (!express) return
    app.use(ASSET_BASE, express.static(PUBLIC_DIR))
    assetsMounted = true
    debug(`assets served at ${ASSET_BASE}`)
  }

  const mountEndpoint = () => {
    if (endpointMounted) return
    if (typeof app.use !== 'function') return
    const express = loadExpress()
    if (!express) return
    const router = express.Router()
    router.use(express.json({ limit: '256kb' }))
    router.post('/route', makeExpressHandler(landSourceOptions))
    app.use(ASSET_BASE, router)
    endpointMounted = true
    debug(`route endpoint mounted at POST ${ASSET_BASE}/route`)
  }

  const registerProvider = () => {
    if (providerRegistered) return
    if (typeof app.registerResourceProvider !== 'function') {
      warn('server has no resource provider registry; manifest not offered')
      return
    }
    app.registerResourceProvider({
      type: 'plotterExtensions',
      methods: {
        listResources: async () => (running ? { [PLUGIN_ID]: buildManifest() } : {}),
        getResource: async (id) => {
          if (!running || id !== PLUGIN_ID) {
            throw new Error(`No such plotterExtensions resource: ${id}`)
          }
          return buildManifest()
        },
        setResource: async () => {
          throw new Error(`${PLUGIN_ID} is a read-only provider`)
        },
        deleteResource: async () => {
          throw new Error(`${PLUGIN_ID} is a read-only provider`)
        }
      }
    })
    providerRegistered = true
  }

  return {
    id: PLUGIN_ID,
    name: 'Auto Route',
    description:
      'Land-avoidance auto-routing for Signal K chartplotters that support the plotterExtensions routes capability.',

    schema: () => ({
      type: 'object',
      properties: {
        landLayer: {
          type: 'string',
          title: 'Land layer name',
          description:
            'Vector-tile layer holding land polygons. Default for S-57-derived charts is LNDARE.',
          default: DEFAULT_LAND_LAYER
        },
        chartPath: {
          type: 'string',
          title: 'Chart directory (optional override)',
          description:
            'Directory scanned for .mbtiles vector charts. Leave blank to use the server default chart directory.'
        },
        bboxPadDeg: {
          type: 'number',
          title: 'Bounding-box padding (degrees)',
          description:
            'How far beyond the route bbox to read land tiles. Larger values catch nearby coastline at the cost of more tiles read.',
          default: 0.02
        }
      }
    }),

    start(opts) {
      running = true
      options = opts || {}
      mountAssets()
      mountEndpoint()
      registerProvider()
      debug('started')
    },

    stop() {
      running = false
      debug('stopped')
    }
  }
}

// Candidate chart directories to scan for .mbtiles, most-specific first:
//   1. an explicit chartPath plugin-config override (if set),
//   2. for each known server base path, both `charts` and `charts-simple`
//      (and a `../charts-simple` sibling) — different chart providers use
//      different folder names; charts-provider-simple writes to charts-simple.
// Kept defensive so a missing app.config can never throw at start.
function chartDirCandidates(app, options) {
  const dirs = []
  if (options && typeof options.chartPath === 'string' && options.chartPath) {
    dirs.push(options.chartPath)
  }
  const bases = new Set()
  // Primary: match charts-provider-simple's default location exactly. It stores
  // charts at dirname(dirname(getDataDirPath()))/charts-simple. Every plugin's
  // getDataDirPath() shares the same <configBase>/plugin-config-data/<id>
  // layout, so computing it from THIS plugin's getDataDirPath() resolves to the
  // same folder — without depending on app.config.configPath (which, as seen on
  // the n2k dev server, can differ from that base).
  try {
    if (typeof app.getDataDirPath === 'function') {
      bases.add(path.dirname(path.dirname(app.getDataDirPath())))
    }
  } catch {
    /* ignore */
  }
  try {
    if (app && app.config) {
      if (app.config.configPath) bases.add(app.config.configPath)
      if (app.config.appPath) bases.add(app.config.appPath)
    }
  } catch {
    /* ignore */
  }
  for (const base of bases) {
    dirs.push(path.join(base, 'charts-simple'))
    dirs.push(path.join(base, 'charts'))
  }
  return dirs
}

module.exports.PLUGIN_ID = PLUGIN_ID
module.exports.ASSET_BASE = ASSET_BASE
module.exports.buildManifest = buildManifest
