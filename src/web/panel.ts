// Auto Route panel — reference TypeScript extension.
//
// Locks onto a live route edit buffer, lets the user set a clearance margin,
// and on "Auto route" POSTs the route to the plugin's server-side engine, then
// writes the land-avoiding result back to the buffer via route.replace. The
// buffer is never changed on error — the user reviews the result and saves
// themselves (this is a land-avoidance convenience, not a safety planner).
//
// This panel is written in TypeScript against the bus's typed extension API:
// `client.route.*` gives compile-time-checked calls with no behavioural change
// from the generic `client.call('route.…', …)` (a plain-JS extension would use
// the latter). It is the reference for the typed-extension best practice; the
// bus stays framework-neutral, so JavaScript extensions remain fully supported.

import {
  connectExtension,
  ExtensionClient,
  RouteData,
  RoutePoint,
  RpcError
} from 'signalk-plotterext-bus/extension'

interface RouteParams {
  clearance: number
  mode: 'fix-segments' | 'full'
  simplify: boolean
  maxViaPoints: number
}

/** Shape returned by POST /plotterext/signalk-auto-route/route. */
interface RouteResponse {
  changed?: boolean
  points: RoutePoint[]
}

interface ErrorBody {
  error?: string
  message?: string
}

const ENDPOINT = '/plotterext/signalk-auto-route/route'
const SAFETY_CAVEAT =
  'Avoids charted land only — not depth, shoals, rocks, or other hazards. ' +
  'Always review the route before navigating.'

let client: ExtensionClient
let lockedRouteId: string | null = null
let lockedRoute: RouteData | null = null
let units: Record<string, string> | null = null

function esc(s: unknown): string {
  return String(s).replace(
    /[&<>"]/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string
  )
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

function setStatus(text: string, kind = ''): void {
  const el = byId('status')
  el.textContent = text
  el.className = `status ${kind}`
}

function distanceUnit(): 'ft' | 'm' {
  // Clearance is a small off-land margin; metres/feet are the sensible
  // choices. Honour the host's length preference when present.
  return units && units.length === 'foot' ? 'ft' : 'm'
}

function clearanceToMetres(value: number): number {
  return distanceUnit() === 'ft' ? value * 0.3048 : value
}

/** Treat any thrown value as a possible RpcError and read its stable reason. */
function reasonOf(err: unknown): string | undefined {
  return err instanceof RpcError ? err.reason : undefined
}

function renderRoute(): void {
  const info = byId('routeInfo')
  const btn = byId<HTMLButtonElement>('autoRoute')
  byId<HTMLButtonElement>('saveRoute').disabled = !lockedRoute
  if (!lockedRoute) {
    info.textContent =
      'Draw a route on the chart first, then reopen this panel.'
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

async function refreshRoute(): Promise<void> {
  if (!lockedRouteId) return
  try {
    lockedRoute = await client.route.get(lockedRouteId)
  } catch (err) {
    if (reasonOf(err) === 'routes.unknownId') {
      // Buffer vanished — drop the lock and re-pick.
      lockedRouteId = null
      lockedRoute = null
      await pickBuffer()
      return
    }
    setStatus(`Could not read route: ${(err as Error).message}`, 'error')
  }
  renderRoute()
}

// Lock onto a single buffer, or the most-recently-created when several exist.
async function pickBuffer(): Promise<void> {
  try {
    const routes = await client.route.list()
    if (routes.length === 0) {
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
    setStatus(`Could not list routes: ${(err as Error).message}`, 'error')
  }
}

async function autoRoute(): Promise<void> {
  if (!lockedRoute || !lockedRoute.points || lockedRoute.points.length < 2) {
    return
  }
  const btn = byId<HTMLButtonElement>('autoRoute')
  const rawClearance = Number(byId<HTMLInputElement>('clearance').value) || 0
  const params: RouteParams = {
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
      const body = (await resp.json().catch(() => ({}))) as ErrorBody
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
      const body = (await resp.json().catch(() => ({}))) as ErrorBody
      setStatus(body.message || `Routing failed (${resp.status}).`, 'error')
      return
    }

    const result = (await resp.json()) as RouteResponse
    if (!result.changed) {
      setStatus(
        'No land in the way — route already clear. Nothing changed.',
        'ok'
      )
      return
    }

    // Typed convenience wrapper — identical on the wire to
    // client.call('route.replace', { routeId, points }).
    await client.route.replace(lockedRouteId as string, result.points)
    const added = result.points.length - lockedRoute.points.length
    setStatus(
      `Route updated: ${added} via-point${added === 1 ? '' : 's'} added to ` +
        'avoid land. Review it on the chart, then save.',
      'ok'
    )
    // refreshRoute will also be triggered by the route.dirty event from
    // replace, but refresh eagerly too for snappiness.
    await refreshRoute()
  } catch (err) {
    // Buffer is never modified on a fetch/RPC failure.
    setStatus(`Auto route failed: ${(err as Error).message}`, 'error')
  } finally {
    renderRoute()
  }
}

// Persist the locked buffer to a stored route. The host owns the naming UX
// (it opens its route-details dialog); on save the buffer becomes a saved
// route and this panel's lock is released by the route.deleted event.
async function saveRoute(): Promise<void> {
  if (!lockedRouteId) {
    return
  }
  setStatus('Saving route…')
  try {
    const { href } = await client.route.save(lockedRouteId)
    setStatus(`Route saved (${esc(href)}).`, 'ok')
  } catch (err) {
    if (reasonOf(err) === 'routes.saveCancelled') {
      setStatus('Save cancelled — route is still unsaved.')
    } else {
      setStatus(`Save failed: ${(err as Error).message}`, 'error')
    }
  }
}

async function main(): Promise<void> {
  const root = byId('root')
  client = await connectExtension()

  if (client.hasCapability('units')) {
    try {
      const u = (await client.call('units.get', {})) as {
        units?: Record<string, string>
      }
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
      <button type="button" id="saveRoute">Save</button>
      <button type="button" id="autoRoute" class="primary">Auto route</button>
    </div>
    <p class="status" id="status"></p>`

  byId('autoRoute').addEventListener('click', () => {
    void autoRoute()
  })
  byId('saveRoute').addEventListener('click', () => {
    void saveRoute()
  })
  byId('refresh').addEventListener('click', () => {
    void pickBuffer()
  })

  // Follow route lifecycle: re-pick on create/delete, re-fetch on dirty.
  await client.subscribe(['route.**'], (name, params) => {
    const p = params as { routeId?: string }
    if (name === 'route.created') {
      // Newly-created buffer becomes the most-recent candidate.
      lockedRouteId = p.routeId ?? null
      void refreshRoute()
    } else if (name === 'route.deleted') {
      if (p.routeId === lockedRouteId) {
        lockedRouteId = null
        lockedRoute = null
        void pickBuffer()
      }
    } else if (name === 'route.dirty') {
      if (p.routeId === lockedRouteId) void refreshRoute()
    }
  })

  await pickBuffer()
}

main().catch((err: Error) => {
  const root = document.getElementById('root')
  if (root) root.textContent = `Host connection failed: ${err.message}`
  console.warn('auto-route panel:', err)
})
