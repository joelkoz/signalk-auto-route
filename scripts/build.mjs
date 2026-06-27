// Build the panel web assets into public/, which the plugin serves as a
// top-level static route at /plotterext/signalk-auto-route/.

import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pub = join(root, 'public')
mkdirSync(join(pub, 'js'), { recursive: true })

await build({
  entryPoints: [join(root, 'src/web/panel.js')],
  bundle: true,
  format: 'iife',
  outdir: join(pub, 'js'),
  sourcemap: true,
  target: ['es2020'],
  logLevel: 'info'
})

cpSync(join(root, 'src/web/autoroute.css'), join(pub, 'autoroute.css'))

// Static assets (e.g. the app-store icon) ship under public/assets/ so the
// server's icon probe resolves signalk.appIcon ("assets/...") via the
// published tarball's public/ directory.
const assetsSrc = join(root, 'src/web/assets')
if (existsSync(assetsSrc)) {
  cpSync(assetsSrc, join(pub, 'assets'), { recursive: true })
}

const page = (name, bodyClass, title) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="autoroute.css">
</head>
<body class="${bodyClass}">
<div id="root"></div>
<script src="js/${name}.js"></script>
</body>
</html>
`

writeFileSync(join(pub, 'panel.html'), page('panel', 'panel', 'Auto Route'))

writeFileSync(
  join(pub, 'index.html'),
  `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Auto Route</title>
<link rel="stylesheet" href="autoroute.css"></head>
<body class="panel">
<div id="root">
<h2>Auto Route</h2>
<p class="status">This package provides land-avoidance auto-routing for
chartplotters that support the Signal K <code>plotterExtensions</code>
resource type (e.g. Freeboard-SK). Draw a route on the chart, open the
<strong>Auto Route</strong> toolbar button, and press <strong>Auto route</strong>
to insert via-points around charted land. It avoids charted land only — not
depth, shoals, rocks, or other hazards. Needs a vector chart (S-57 / pbf) with
a land layer covering the area, such as one produced by
signalk-charts-provider-simple.</p>
</div>
</body>
</html>
`
)

console.log('public/ assets written')
