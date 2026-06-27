// Auto Route panel.
//
// Locks onto a live route edit buffer, lets the user set a clearance margin,
// and on "Auto route" POSTs the route to the plugin's server-side engine, then
// writes the land-avoiding result back to the buffer via route.replace. The
// buffer is never changed on error — the user reviews the result and saves
// themselves (this is a land-avoidance convenience, not a safety planner).

import { connectExtension } from 'signalk-plotterext-bus/extension'

const ENDPOINT = '/plotterext/signalk-auto-route/route'
const SAFETY_CAVEAT =
  'Avoids charted land only — not depth, shoals, rocks, or other hazards. ' +
  'Always review the route before navigating.'

let client
let lockedRouteId = null
let lockedRoute = null // { routeId, name, rev, saved, points }
let units = null

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  )
}

function setStatus(text, kind = '') {
  const el = document.getElementById('status')
  el.textContent = text
  el.className = `status ${kind}`
}

function distanceUnit() {
  // Clearance is a small off-land margin; metres/feet are the sensible
  // choices. Honour the host's length preference when present.
  const len = units && units.length
  return len === 'foot' ? 'ft' : 'm'
}

function clearanceToMetres(value) {
  return distanceUnit() === 'ft' ? value * 0.3048 : value
}

function renderRoute() {
  const info = document.getElementById('routeInfo')
  const btn = document.getElementById('autoRoute')
  if (!lockedRoute) {
    info.textContent = 'Draw a route on the chart first, then reopen this panel.'
    btn.disabled = true
    return
  }
  const n = lockedRoute.points ? lockedRoute.points.length : 0
  info.innerHTML =
    `<strong>${esc(lockedRoute.name || 'Route')}</strong>` +
    ` <span class="muted">· ${n} point${n === 1 ? '' : 's'}` +
    `${lockedRoute.saved ? '' : ' · unsaved'}</span>`
  btn.disabled = n < 2
}

async function refreshRoute() {
  if (!lockedRouteId) return
  try {
    lockedRoute = await client.call('route.get', { routeId: lockedRouteId })
  } catch (err) {
    if (err && err.data && err.data.reason === 'routes.unknownId') {
      // Buffer vanished — drop the lock and re-pick.
      lockedRouteId = null
      lockedRoute = null
      await pickBuffer()
      return
    }
    setStatus(`Could not read route: ${err.message}`, 'error')
  }
  renderRoute()
}

// Lock onto a single buffer, or the most-recently-created when several exist.
async function pickBuffer() {
  try {
    const { routes } = await client.call('route.list', {})
    if (!routes || routes.length === 0) {
      lockedRouteId = null
      lockedRoute = null
      renderRoute()
      return
    }
    // Prefer the currently locked one if still present; else the last listed
    // (the host appends newly-created buffers, so last ≈ most recent).
    const stillThere = routes.find((r) => r.routeId === lockedRouteId)
    const chosen = stillThere || routes[routes.length - 1]
    lockedRouteId = chosen.routeId
    await refreshRoute()
  } catch (err) {
    setStatus(`Could not list routes: ${err.message}`, 'error')
  }
}

async function autoRoute() {
  if (!lockedRoute || !lockedRoute.points || lockedRoute.points.length < 2) {
    return
  }
  const btn = document.getElementById('autoRoute')
  const rawClearance = Number(document.getElementById('clearance').value) || 0
  const params = {
    clearance: clearanceToMetres(rawClearance),
    mode: 'fix-segments',
    simplify: true,
    maxViaPoints: 50
  }

  btn.disabled = true
  setStatus('Computing land-avoiding route…')
  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: lockedRoute.points, params })
    })

    if (resp.status === 422) {
      const body = await resp.json().catch(() => ({}))
      if (body.error === 'land-source/none') {
        setStatus(
          'No land data for this area — install or enable a vector chart ' +
            '(S-57 / pbf) covering these waters. The route was not changed.',
          'warn'
        )
        return
      }
      setStatus(body.message || 'Routing failed.', 'warn')
      return
    }
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}))
      setStatus(body.message || `Routing failed (${resp.status}).`, 'error')
      return
    }

    const result = await resp.json()
    if (!result.changed) {
      setStatus('No land in the way — route already clear. Nothing changed.', 'ok')
      return
    }

    await client.call('route.replace', {
      routeId: lockedRouteId,
      points: result.points
    })
    const added = result.points.length - lockedRoute.points.length
    setStatus(
      `Route updated: ${added} via-point${added === 1 ? '' : 's'} added to ` +
        'avoid land. Review it on the chart, then save.',
      'ok'
    )
    // refreshRoute will be triggered by the route.dirty event from replace,
    // but refresh eagerly too for snappiness.
    await refreshRoute()
  } catch (err) {
    // Buffer is never modified on a fetch/RPC failure.
    setStatus(`Auto route failed: ${err.message}`, 'error')
  } finally {
    renderRoute()
  }
}

async function main() {
  const root = document.getElementById('root')
  client = await connectExtension()

  if (client.hasCapability && client.hasCapability('units')) {
    try {
      const u = await client.call('units.get', {})
      units = u && u.units ? u.units : null
    } catch {
      units = null
    }
  }

  const unit = distanceUnit()
  const defaultClearance = unit === 'ft' ? 165 : 50 // ≈ 50 m

  root.innerHTML = `
    <p class="caveat">${esc(SAFETY_CAVEAT)}</p>
    <div id="routeInfo" class="route-info"></div>
    <label class="row"><span>Clearance (${unit})</span>
      <input id="clearance" type="number" min="0" max="100000"
             value="${defaultClearance}"></label>
    <div class="actions">
      <button type="button" id="refresh">Refresh</button>
      <button type="button" id="autoRoute" class="primary">Auto route</button>
    </div>
    <p class="status" id="status"></p>`

  document.getElementById('autoRoute').addEventListener('click', autoRoute)
  document.getElementById('refresh').addEventListener('click', pickBuffer)

  // Follow route lifecycle: re-pick on create/delete, re-fetch on dirty.
  await client.subscribe(['route.**'], (name, params) => {
    if (name === 'route.created') {
      // Newly-created buffer becomes the most-recent candidate.
      lockedRouteId = params.routeId
      refreshRoute()
    } else if (name === 'route.deleted') {
      if (params.routeId === lockedRouteId) {
        lockedRouteId = null
        lockedRoute = null
        pickBuffer()
      }
    } else if (name === 'route.dirty') {
      if (params.routeId === lockedRouteId) refreshRoute()
    }
  })

  await pickBuffer()
}

main().catch((err) => {
  const root = document.getElementById('root')
  if (root) root.textContent = `Host connection failed: ${err.message}`
  console.warn('auto-route panel:', err)
})
