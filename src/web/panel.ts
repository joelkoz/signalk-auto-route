// Auto Route panel — reference TypeScript extension.
//
// Lists the routes currently visible on the chart in a dropdown and lets the
// user pick one to auto-route. The dropdown is kept in sync by *listening for
// route.visible / route.hidden events* — this panel doubles as the reference
// for how an extension follows the host's visible-route set. On "Auto route" it
// POSTs the chosen route to the plugin's server-side engine and writes the
// land-avoiding result back via route.replace. The route is never changed on
// error — the user reviews and saves it themselves (this is a land-avoidance
// convenience, not a safety planner).
//
// Written in TypeScript against the bus's typed extension API (client.route.*
// and the typed event payloads); a plain-JS extension would use the generic
// client.call('route.…', …) and read params untyped. The bus stays
// framework-neutral, so JavaScript extensions remain fully supported.

import {
  connectExtension,
  ExtensionClient,
  RouteData,
  RouteDirtyEvent,
  RouteHiddenEvent,
  RoutePoint,
  RouteSavedEvent,
  RouteSummary,
  RouteVisibleEvent,
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
const PLACEHOLDER = '-- Select a route --'

let client: ExtensionClient
// The routes currently visible on the chart, kept in sync from route.visible /
// route.hidden (seeded once from route.list). This is the panel's mirror of the
// host's visible set.
let visibleRoutes: RouteSummary[] = []
let selectedRouteId: string | null = null
let selectedRoute: RouteData | null = null
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

// ---- visible-route list (the dropdown) --------------------------------------

/** Dropdown label: name + an "unsaved" marker (a route with no resource yet, or
 *  with pending edits). Point counts live in the detail line, not here, so the
 *  label never goes stale. */
function optionLabel(r: RouteSummary): string {
  const name = r.name || 'Unnamed route'
  const unsaved = !r.saved || r.dirty
  return `${name}${unsaved ? ' · unsaved' : ''}`
}

/** Insert or update a route in the local mirror. */
function upsertVisible(ev: RouteVisibleEvent): void {
  const entry: RouteSummary = {
    routeId: ev.routeId,
    name: ev.name,
    rev: ev.rev,
    pointCount: ev.pointCount,
    saved: ev.saved,
    dirty: ev.dirty
  }
  const i = visibleRoutes.findIndex((r) => r.routeId === ev.routeId)
  if (i >= 0) visibleRoutes[i] = entry
  else visibleRoutes.push(entry)
}

/** Patch a mirrored route's flags in place (used on dirty/saved). */
function patchVisible(routeId: string, patch: Partial<RouteSummary>): void {
  const r = visibleRoutes.find((x) => x.routeId === routeId)
  if (r) Object.assign(r, patch)
}

/** Rebuild the dropdown from the mirror, preserving the current selection. */
function renderOptions(): void {
  const sel = byId<HTMLSelectElement>('routeSelect')
  const opts = [`<option value="">${esc(PLACEHOLDER)}</option>`]
  for (const r of visibleRoutes) {
    opts.push(
      `<option value="${esc(r.routeId)}">${esc(optionLabel(r))}</option>`
    )
  }
  sel.innerHTML = opts.join('')
  if (
    selectedRouteId &&
    visibleRoutes.some((r) => r.routeId === selectedRouteId)
  ) {
    sel.value = selectedRouteId
  } else {
    // The selection is gone (hidden/deleted) — fall back to the placeholder.
    sel.value = ''
    selectedRouteId = null
    selectedRoute = null
  }
}

function renderInfo(): void {
  const info = byId('routeInfo')
  const save = byId<HTMLButtonElement>('saveRoute')
  if (!selectedRoute) {
    info.textContent = visibleRoutes.length
      ? 'Select a route above to auto-route it.'
      : 'No routes on the chart yet — draw one or show a saved route.'
    save.disabled = true
    return
  }
  const n = selectedRoute.points ? selectedRoute.points.length : 0
  const unsaved = !selectedRoute.saved || selectedRoute.dirty
  info.innerHTML =
    `<strong>${esc(selectedRoute.name || 'Unnamed route')}</strong>` +
    ` <span class="muted">· ${n} point${n === 1 ? '' : 's'}${
      unsaved ? ' · unsaved' : ''
    }</span>`
  save.disabled = !unsaved
}

/** Fetch the selected route's geometry for the detail line + auto-routing. */
async function refreshSelected(): Promise<void> {
  if (!selectedRouteId) {
    selectedRoute = null
    renderInfo()
    return
  }
  try {
    selectedRoute = await client.route.get(selectedRouteId)
  } catch (err) {
    if (reasonOf(err) === 'routes.unknownId') {
      selectedRouteId = null
      selectedRoute = null
    } else {
      setStatus(`Could not read route: ${(err as Error).message}`, 'error')
    }
  }
  renderInfo()
}

/** Seed/refresh the whole list from the host (initial load + Refresh button). */
async function refreshList(): Promise<void> {
  try {
    visibleRoutes = await client.route.list()
  } catch (err) {
    setStatus(`Could not list routes: ${(err as Error).message}`, 'error')
    return
  }
  renderOptions()
  await refreshSelected()
}

function onSelectChange(): void {
  selectedRouteId = byId<HTMLSelectElement>('routeSelect').value || null
  selectedRoute = null
  setStatus('')
  void refreshSelected()
}

// ---- actions ----------------------------------------------------------------

async function autoRoute(): Promise<void> {
  if (!selectedRouteId) {
    setStatus('Select the route to work with.', 'warn')
    return
  }
  // Make sure we are working with the current geometry.
  await refreshSelected()
  if (
    !selectedRoute ||
    !selectedRoute.points ||
    selectedRoute.points.length < 2
  ) {
    setStatus('The selected route needs at least two points.', 'warn')
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
      body: JSON.stringify({ points: selectedRoute.points, params })
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
    await client.route.replace(selectedRouteId, result.points)
    const added = result.points.length - selectedRoute.points.length
    setStatus(
      `Route updated: ${added} via-point${added === 1 ? '' : 's'} added to ` +
        'avoid land. Review it on the chart, then save.',
      'ok'
    )
    // route.replace emits route.dirty, which refreshes us, but update eagerly.
    await refreshSelected()
  } catch (err) {
    // The route is never modified on a fetch/RPC failure.
    setStatus(`Auto route failed: ${(err as Error).message}`, 'error')
  } finally {
    byId<HTMLButtonElement>('autoRoute').disabled = false
  }
}

// Persist the selected route. The host owns the naming UX (dialog:true opens its
// route-details dialog); on save the route stays visible/selected, now saved and
// clean (route.saved), so the panel keeps operating on the same routeId.
async function saveRoute(): Promise<void> {
  if (!selectedRouteId) {
    setStatus('Select a route to save.', 'warn')
    return
  }
  setStatus('Saving route…')
  try {
    const { href } = await client.route.save(selectedRouteId, { dialog: true })
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
    <label class="row"><span>Route</span>
      <select id="routeSelect"></select></label>
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

  byId('routeSelect').addEventListener('change', onSelectChange)
  byId('autoRoute').addEventListener('click', () => {
    void autoRoute()
  })
  byId('saveRoute').addEventListener('click', () => {
    void saveRoute()
  })
  byId('refresh').addEventListener('click', () => {
    void refreshList()
  })

  // Keep the dropdown in sync with the host's visible route set. route.visible /
  // route.hidden add and remove entries; route.dirty / route.saved update an
  // entry's flags (and the detail line, if it is the selected route).
  await client.subscribe(['route.**'], (name, params) => {
    if (name === 'route.visible') {
      upsertVisible(params as RouteVisibleEvent)
      renderOptions()
      renderInfo()
    } else if (name === 'route.hidden') {
      const e = params as RouteHiddenEvent
      const wasSelected = e.routeId === selectedRouteId
      visibleRoutes = visibleRoutes.filter((r) => r.routeId !== e.routeId)
      renderOptions()
      if (wasSelected) {
        setStatus('The selected route is no longer visible.')
      }
      renderInfo()
    } else if (name === 'route.saved') {
      const e = params as RouteSavedEvent
      // Carry the (possibly dialog-set) name so the label updates, e.g. an
      // unnamed draft that the user just saved as "rt1".
      patchVisible(e.routeId, {
        name: e.name,
        saved: e.saved,
        dirty: e.dirty
      })
      renderOptions()
      if (e.routeId === selectedRouteId) void refreshSelected()
    } else if (name === 'route.dirty') {
      const e = params as RouteDirtyEvent
      patchVisible(e.routeId, { dirty: true })
      renderOptions()
      if (e.routeId === selectedRouteId) void refreshSelected()
    }
  })

  await refreshList()
}

main().catch((err: Error) => {
  const root = document.getElementById('root')
  if (root) root.textContent = `Host connection failed: ${err.message}`
  console.warn('auto-route panel:', err)
})
