// Plugin contract tests (no running Signal K server).

'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

function fakeApp() {
  const calls = { providers: [], mounts: [] }
  return {
    calls,
    debug: () => {},
    error: () => {},
    use: (route, handler) => calls.mounts.push({ route, handler }),
    registerResourceProvider: (p) => calls.providers.push(p)
  }
}

test('registers a read-only plotterExtensions provider with a valid manifest', async () => {
  const app = fakeApp()
  const plugin = require('../plugin/index.js')(app)
  plugin.start({})

  const provider = app.calls.providers[0]
  assert.strictEqual(provider.type, 'plotterExtensions')

  const list = await provider.methods.listResources({})
  const manifest = list['signalk-auto-route']
  assert.ok(manifest)
  assert.strictEqual(manifest.name, 'Auto Route')
  assert.strictEqual(manifest.apiVersion, '1')
  assert.deepStrictEqual(manifest.requires, ['buttons', 'panels.iframe', 'routes'])
  assert.deepStrictEqual(manifest.optional, ['map', 'units'])

  // Button → panel wiring.
  const button = manifest.buttons[0]
  assert.strictEqual(button.id, 'open-auto-route')
  assert.strictEqual(button.slot, 'mapToolbar')
  assert.strictEqual(button.icon, 'alt_route')
  assert.strictEqual(button.action.type, 'togglePanel')
  assert.strictEqual(button.action.panel, manifest.panels[0].id)

  // Panel.
  assert.strictEqual(manifest.panels[0].id, 'auto-route-panel')
  assert.strictEqual(manifest.panels[0].type, 'iframe')
  assert.strictEqual(manifest.panels[0].lifecycle, 'keepAlive')
  assert.ok(manifest.panels[0].url.startsWith('/plotterext/signalk-auto-route/'))

  await assert.rejects(() => provider.methods.getResource('nope'))
  await assert.rejects(() => provider.methods.setResource('x', {}))
  await assert.rejects(() => provider.methods.deleteResource('x'))
})

test('provider returns empty list when stopped', async () => {
  const app = fakeApp()
  const plugin = require('../plugin/index.js')(app)
  plugin.start({})
  plugin.stop()
  assert.deepStrictEqual(
    await app.calls.providers[0].methods.listResources({}),
    {}
  )
})

test('mounts static assets and the route endpoint under the asset base', () => {
  const app = fakeApp()
  const plugin = require('../plugin/index.js')(app)
  plugin.start({})
  const routes = app.calls.mounts.map((m) => m.route)
  assert.ok(routes.every((r) => r === '/plotterext/signalk-auto-route'))
  assert.ok(app.calls.mounts.length >= 2) // static + endpoint router
})

test('package declares the chart-provider recommendation and keywords', () => {
  const pkg = require('../package.json')
  assert.ok(pkg.keywords.includes('signalk-node-server-plugin'))
  assert.ok(pkg.keywords.includes('signalk-category-chart-plotters'))
  assert.ok(pkg.signalk.recommends.includes('signalk-charts-provider-simple'))
  assert.strictEqual(pkg['signalk-plugin-enabled-by-default'], false)
})
