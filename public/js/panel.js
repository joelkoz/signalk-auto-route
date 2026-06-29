(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // node_modules/signalk-plotterext-bus/dist/chunk-LVGWVV2W.js
  var BUS_ID = "plotterExt/1";
  var RPC_ERRORS = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
    HOST_ERROR: -32e3,
    TIMEOUT: -32001,
    CONNECTION_CLOSED: -32002
  };
  var RpcError = class _RpcError extends Error {
    constructor(message, opts = {}) {
      super(message);
      __publicField(this, "code");
      __publicField(this, "data");
      this.name = "RpcError";
      this.code = opts.code ?? RPC_ERRORS.HOST_ERROR;
      const data = { ...opts.data ?? {} };
      if (opts.reason !== void 0) data.reason = opts.reason;
      this.data = Object.keys(data).length > 0 ? data : void 0;
    }
    get reason() {
      return typeof this.data?.reason === "string" ? this.data.reason : void 0;
    }
    toErrorObject() {
      return {
        code: this.code,
        message: this.message,
        ...this.data ? { data: this.data } : {}
      };
    }
    static fromErrorObject(err) {
      return new _RpcError(err.message, { code: err.code, data: err.data });
    }
    /** Normalize any thrown value into an RpcError suitable for the wire. */
    static from(err) {
      if (err instanceof _RpcError) return err;
      if (err instanceof Error) {
        return new _RpcError(err.message, { code: RPC_ERRORS.INTERNAL_ERROR });
      }
      return new _RpcError(String(err), { code: RPC_ERRORS.INTERNAL_ERROR });
    }
  };
  var EVENT_READY = "bus.ready";
  var EVENT_HANDSHAKE = "bus.handshake";
  function matchesPattern(pattern, name) {
    if (pattern === name) return true;
    return match(pattern.split("."), 0, name.split("."), 0);
  }
  function match(p, pi, n, ni) {
    while (pi < p.length) {
      const seg = p[pi];
      if (seg === "**") {
        if (pi === p.length - 1) return true;
        for (let skip = ni; skip <= n.length; skip++) {
          if (match(p, pi + 1, n, skip)) return true;
        }
        return false;
      }
      if (ni >= n.length) return false;
      if (seg !== "*" && seg !== n[ni]) return false;
      pi++;
      ni++;
    }
    return ni === n.length;
  }
  function matchesAny(patterns, name) {
    for (const pattern of patterns) {
      if (matchesPattern(pattern, name)) return true;
    }
    return false;
  }
  function wrap(msg) {
    return { bus: BUS_ID, msg };
  }
  function unwrap(data) {
    if (typeof data !== "object" || data === null) return null;
    const env = data;
    if (env.bus !== BUS_ID) return null;
    return isJsonRpcMessage(env.msg) ? env.msg : null;
  }
  function isJsonRpcMessage(v) {
    if (typeof v !== "object" || v === null) return false;
    const m = v;
    if (m.jsonrpc !== "2.0") return false;
    if (typeof m.method === "string") {
      return m.id === void 0 || typeof m.id === "string" || typeof m.id === "number";
    }
    const idOk = typeof m.id === "string" || typeof m.id === "number" || m.id === null;
    if (!idOk) return false;
    const hasResult = "result" in m;
    const err = m.error;
    const hasError = typeof err === "object" && err !== null && typeof err.code === "number" && typeof err.message === "string";
    return hasResult ? !("error" in m) : hasError;
  }
  function isRequest(msg) {
    return "method" in msg && "id" in msg && msg.id !== void 0;
  }
  function isNotification(msg) {
    return "method" in msg && (!("id" in msg) || msg.id === void 0);
  }
  function isResponse(msg) {
    return !("method" in msg);
  }
  function windowPort(peer, opts = {}) {
    const listenWindow = opts.listenWindow ?? globalThis;
    const origin = opts.origin ?? listenWindow.location?.origin ?? "*";
    return {
      post(data) {
        peer.postMessage(data, origin);
      },
      listen(handler) {
        const fn = (ev) => {
          if (ev.source !== peer) return;
          if (origin !== "*" && ev.origin !== origin) return;
          handler(ev.data);
        };
        listenWindow.addEventListener("message", fn);
        return () => listenWindow.removeEventListener("message", fn);
      }
    };
  }
  var DEFAULT_CALL_TIMEOUT_MS = 1e4;
  var BusEndpoint = class {
    constructor(opts) {
      __publicField(this, "callTimeoutMs");
      __publicField(this, "port");
      __publicField(this, "unlisten");
      __publicField(this, "onError");
      __publicField(this, "pending", /* @__PURE__ */ new Map());
      __publicField(this, "methods", /* @__PURE__ */ new Map());
      __publicField(this, "eventHandlers", /* @__PURE__ */ new Set());
      __publicField(this, "idPrefix", Math.random().toString(36).slice(2, 8));
      __publicField(this, "seq", 0);
      __publicField(this, "closed", false);
      this.port = opts.port;
      this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
      this.onError = opts.onError ?? ((err) => console.warn("[plotterext-bus]", err));
      this.unlisten = this.port.listen((data) => this.onData(data));
    }
    registerMethod(name, handler) {
      this.methods.set(name, handler);
    }
    unregisterMethod(name) {
      this.methods.delete(name);
    }
    /**
     * Handle incoming notifications whose names match any of the wildcard
     * patterns. Returns an unsubscribe function. This is local dispatch only;
     * telling the peer which events to forward is a separate concern
     * (`events.subscribe`).
     */
    onEvent(patterns, fn) {
      const entry = { patterns, fn };
      this.eventHandlers.add(entry);
      return () => this.eventHandlers.delete(entry);
    }
    /** Send a notification (an event) to the peer. */
    notify(method, params) {
      this.send({ jsonrpc: "2.0", method, ...params !== void 0 ? { params } : {} });
    }
    /** Call a method on the peer; resolves with its result. */
    call(method, params, opts = {}) {
      if (this.closed) {
        return Promise.reject(
          new RpcError("Bus endpoint is closed", {
            code: RPC_ERRORS.CONNECTION_CLOSED,
            reason: "CLOSED"
          })
        );
      }
      const id = `${this.idPrefix}-${++this.seq}`;
      const timeoutMs = opts.timeoutMs ?? this.callTimeoutMs;
      return new Promise((resolve, reject) => {
        const timer = timeoutMs > 0 ? setTimeout(() => {
          this.pending.delete(id);
          reject(
            new RpcError(`Call timed out after ${timeoutMs}ms: ${method}`, {
              code: RPC_ERRORS.TIMEOUT,
              reason: "TIMEOUT"
            })
          );
        }, timeoutMs) : null;
        this.pending.set(id, { resolve, reject, timer });
        this.send({
          jsonrpc: "2.0",
          id,
          method,
          ...params !== void 0 ? { params } : {}
        });
      });
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.unlisten();
      for (const [, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(
          new RpcError("Bus endpoint closed", {
            code: RPC_ERRORS.CONNECTION_CLOSED,
            reason: "CLOSED"
          })
        );
      }
      this.pending.clear();
      this.eventHandlers.clear();
    }
    send(msg) {
      if (this.closed) return;
      this.port.post(wrap(msg));
    }
    onData(data) {
      const msg = unwrap(data);
      if (!msg) return;
      if (isResponse(msg)) {
        this.onResponse(msg);
      } else if (isRequest(msg)) {
        void this.onRequest(msg);
      } else if (isNotification(msg)) {
        this.onNotification(msg.method, msg.params);
      }
    }
    onResponse(msg) {
      if (msg.id === null) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if ("error" in msg) {
        p.reject(RpcError.fromErrorObject(msg.error));
      } else {
        p.resolve(msg.result);
      }
    }
    async onRequest(msg) {
      const handler = this.methods.get(msg.method);
      if (!handler) {
        this.send({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: RPC_ERRORS.METHOD_NOT_FOUND,
            message: `Method not found: ${msg.method}`
          }
        });
        return;
      }
      try {
        const result = await handler(msg.params, { endpoint: this });
        this.send({
          jsonrpc: "2.0",
          id: msg.id,
          result: result === void 0 ? null : result
        });
      } catch (err) {
        this.send({
          jsonrpc: "2.0",
          id: msg.id,
          error: RpcError.from(err).toErrorObject()
        });
      }
    }
    onNotification(name, params) {
      for (const entry of [...this.eventHandlers]) {
        if (matchesAny(entry.patterns, name)) {
          try {
            entry.fn(name, params);
          } catch (err) {
            this.onError(err);
          }
        }
      }
    }
  };

  // node_modules/signalk-plotterext-bus/dist/chunk-YL2LWXNX.js
  var ExtensionClient = class {
    constructor(endpoint, handshake) {
      __publicField(this, "handshake");
      __publicField(this, "endpoint");
      /** Host-persisted key/value state (see spec: State Storage). */
      __publicField(this, "state", {
        get: async (keys, scope) => {
          const result = await this.call("state.get", {
            ...scope ? { scope } : {},
            ...keys ? { keys } : {}
          });
          return result.values ?? {};
        },
        set: async (values, scope) => {
          await this.call("state.set", {
            ...scope ? { scope } : {},
            values
          });
        }
      });
      /** Signal K data relayed by the host (capabilities signalk.stream / .put). */
      __publicField(this, "signalk", {
        /**
         * Subscribe to Signal K path values. The host publishes them as
         * `sk.<path>` events; this helper hides the event-name mapping and
         * establishes both the event-forwarding subscription and the host's
         * upstream Signal K subscription.
         */
        subscribe: async (paths, handler) => {
          const patterns = paths.map((p) => `sk.${p}`);
          const offEvents = await this.subscribe(
            patterns,
            (_name, params) => handler(params)
          );
          let subscriptionId;
          try {
            const result = await this.call("signalk.subscribe", { paths });
            subscriptionId = result.subscriptionId;
          } catch (err) {
            await offEvents();
            throw err;
          }
          return async () => {
            await offEvents();
            await this.call("signalk.unsubscribe", { subscriptionId }).catch(
              () => {
              }
            );
          };
        },
        put: (path, value) => {
          return this.call("signalk.put", { path, value });
        }
      });
      /**
       * The host's visible routes (capability `routes`). Thin **typed** wrappers over
       * the host's `route.*` methods — each just delegates to `this.call(...)`, so a
       * plain-JS extension can call `client.call('route.replace', …)` directly and a
       * TypeScript extension gets the typed `client.route.replace(…)` sugar with no
       * behavioural difference. Follow lifecycle + mutations by subscribing to
       * `route.**` events (`RouteVisibleEvent` / `RouteDirtyEvent` / `RouteSavedEvent`
       * / `RouteHiddenEvent`). Further operations (rename/point ops) extend this
       * surface as the capability fills out.
       */
      __publicField(this, "route", {
        list: async () => {
          const result = await this.call("route.list");
          return result.routes ?? [];
        },
        create: async (opts) => {
          return await this.call("route.create", opts);
        },
        get: async (routeId) => {
          return await this.call("route.get", { routeId });
        },
        replace: async (routeId, points) => {
          return await this.call("route.replace", { routeId, points });
        },
        save: async (routeId, opts) => {
          return await this.call("route.save", {
            routeId,
            ...opts ?? {}
          });
        },
        show: async (ref) => {
          return await this.call("route.show", { ref });
        },
        hide: async (routeId) => {
          await this.call("route.hide", { routeId });
        },
        delete: async (routeId) => {
          await this.call("route.delete", { routeId });
        }
      });
      this.endpoint = endpoint;
      this.handshake = handshake;
    }
    get context() {
      return this.handshake.context;
    }
    get apiVersion() {
      return this.handshake.apiVersion;
    }
    get capabilities() {
      return this.handshake.capabilities;
    }
    hasCapability(id) {
      return this.handshake.capabilities.includes(id);
    }
    /** Call a host API method. */
    call(method, params, opts) {
      return this.endpoint.call(method, params, opts);
    }
    /** Send a notification to the host. */
    notify(method, params) {
      this.endpoint.notify(method, params);
    }
    /**
     * Subscribe to host events matching wildcard patterns. Registers both the
     * host-side forwarding subscription and local dispatch; the returned
     * function tears down both.
     */
    async subscribe(patterns, handler) {
      const off = this.endpoint.onEvent(patterns, handler);
      let subscriptionId;
      try {
        const result = await this.call("events.subscribe", { patterns });
        subscriptionId = result.subscriptionId;
      } catch (err) {
        off();
        throw err;
      }
      return async () => {
        off();
        await this.call("events.unsubscribe", { subscriptionId }).catch(() => {
        });
      };
    }
    close() {
      this.endpoint.close();
    }
  };
  function connectExtension(opts = {}) {
    const port = opts.port ?? windowPort(globalThis.parent, {
      origin: "*"
    });
    const endpoint = new BusEndpoint({
      port,
      callTimeoutMs: opts.callTimeoutMs,
      onError: opts.onError
    });
    return new Promise((resolve, reject) => {
      let done = false;
      const off = endpoint.onEvent([EVENT_HANDSHAKE], (_name, params) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(new ExtensionClient(endpoint, params));
      });
      const interval = setInterval(
        () => endpoint.notify(EVENT_READY),
        opts.readyIntervalMs ?? 250
      );
      const timeout = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        endpoint.close();
        reject(
          new RpcError("Timed out waiting for host handshake", {
            code: RPC_ERRORS.TIMEOUT,
            reason: "HANDSHAKE_TIMEOUT"
          })
        );
      }, opts.timeoutMs ?? 1e4);
      const cleanup = () => {
        off();
        clearInterval(interval);
        clearTimeout(timeout);
      };
      endpoint.notify(EVENT_READY);
    });
  }

  // src/web/panel.ts
  var ENDPOINT = "/plotterext/signalk-auto-route/route";
  var SAFETY_CAVEAT = "Avoids charted land only \u2014 not depth, shoals, rocks, or other hazards. Always review the route before navigating.";
  var PLACEHOLDER = "-- Select a route --";
  var client;
  var visibleRoutes = [];
  var selectedRouteId = null;
  var selectedRoute = null;
  var autoSelected = false;
  var units = null;
  function esc(s) {
    return String(s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]
    );
  }
  function byId(id) {
    return document.getElementById(id);
  }
  function setStatus(text, kind = "") {
    const el = byId("status");
    el.textContent = text;
    el.className = `status ${kind}`;
  }
  function distanceUnit() {
    return units && units.length === "foot" ? "ft" : "m";
  }
  function clearanceToMetres(value) {
    return distanceUnit() === "ft" ? value * 0.3048 : value;
  }
  function reasonOf(err) {
    return err instanceof RpcError ? err.reason : void 0;
  }
  function optionLabel(r) {
    const name = r.name || "Unnamed route";
    const unsaved = !r.saved || r.dirty;
    return `${name}${unsaved ? " \xB7 unsaved" : ""}`;
  }
  function upsertVisible(ev) {
    const entry = {
      routeId: ev.routeId,
      name: ev.name,
      rev: ev.rev,
      pointCount: ev.pointCount,
      saved: ev.saved,
      dirty: ev.dirty
    };
    const i = visibleRoutes.findIndex((r) => r.routeId === ev.routeId);
    if (i >= 0) visibleRoutes[i] = entry;
    else visibleRoutes.push(entry);
  }
  function patchVisible(routeId, patch) {
    const r = visibleRoutes.find((x) => x.routeId === routeId);
    if (r) Object.assign(r, patch);
  }
  function reconcileSelection() {
    if (visibleRoutes.length === 1) {
      selectedRouteId = visibleRoutes[0].routeId;
      autoSelected = true;
    } else if (visibleRoutes.length === 0) {
      selectedRouteId = null;
      autoSelected = false;
    } else {
      if (autoSelected || !selectedRouteId || !visibleRoutes.some((r) => r.routeId === selectedRouteId)) {
        selectedRouteId = null;
      }
      autoSelected = false;
    }
  }
  function renderOptions() {
    const sel = byId("routeSelect");
    byId("routeRow").style.display = visibleRoutes.length >= 2 ? "" : "none";
    const opts = [`<option value="">${esc(PLACEHOLDER)}</option>`];
    for (const r of visibleRoutes) {
      opts.push(
        `<option value="${esc(r.routeId)}">${esc(optionLabel(r))}</option>`
      );
    }
    sel.innerHTML = opts.join("");
    sel.value = selectedRouteId ?? "";
  }
  function syncUi() {
    reconcileSelection();
    renderOptions();
    void refreshSelected();
  }
  function renderInfo() {
    const info = byId("routeInfo");
    const save = byId("saveRoute");
    if (!selectedRoute) {
      info.textContent = visibleRoutes.length ? "Select a route above to auto-route it." : "No routes on the chart yet \u2014 draw one or show a saved route.";
      save.disabled = true;
      return;
    }
    const n = selectedRoute.points ? selectedRoute.points.length : 0;
    const unsaved = !selectedRoute.saved || selectedRoute.dirty;
    info.innerHTML = `<strong>${esc(selectedRoute.name || "Unnamed route")}</strong> <span class="muted">\xB7 ${n} point${n === 1 ? "" : "s"}${unsaved ? " \xB7 unsaved" : ""}</span>`;
    save.disabled = !unsaved;
  }
  async function refreshSelected() {
    if (!selectedRouteId) {
      selectedRoute = null;
      renderInfo();
      return;
    }
    try {
      selectedRoute = await client.route.get(selectedRouteId);
    } catch (err) {
      if (reasonOf(err) === "routes.unknownId") {
        selectedRouteId = null;
        selectedRoute = null;
      } else {
        setStatus(`Could not read route: ${err.message}`, "error");
      }
    }
    renderInfo();
  }
  async function refreshList() {
    try {
      visibleRoutes = await client.route.list();
    } catch (err) {
      setStatus(`Could not list routes: ${err.message}`, "error");
      return;
    }
    reconcileSelection();
    renderOptions();
    await refreshSelected();
  }
  function onSelectChange() {
    selectedRouteId = byId("routeSelect").value || null;
    autoSelected = false;
    selectedRoute = null;
    setStatus("");
    void refreshSelected();
  }
  async function autoRoute() {
    if (visibleRoutes.length === 0) {
      setStatus("Draw or show a route on the chart first.", "warn");
      return;
    }
    if (!selectedRouteId) {
      setStatus("Select the route to work with.", "warn");
      return;
    }
    await refreshSelected();
    if (!selectedRoute || !selectedRoute.points || selectedRoute.points.length < 2) {
      setStatus("The selected route needs at least two points.", "warn");
      return;
    }
    const btn = byId("autoRoute");
    const rawClearance = Number(byId("clearance").value) || 0;
    const params = {
      clearance: clearanceToMetres(rawClearance),
      mode: "fix-segments",
      simplify: true,
      maxViaPoints: 50
    };
    btn.disabled = true;
    setStatus("Computing land-avoiding route\u2026");
    try {
      const resp = await fetch(ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: selectedRoute.points, params })
      });
      if (resp.status === 422) {
        const body = await resp.json().catch(() => ({}));
        if (body.error === "land-source/none") {
          setStatus(
            "No land data for this area \u2014 install or enable a vector chart (S-57 / pbf) covering these waters. The route was not changed.",
            "warn"
          );
          return;
        }
        setStatus(body.message || "Routing failed.", "warn");
        return;
      }
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        setStatus(body.message || `Routing failed (${resp.status}).`, "error");
        return;
      }
      const result = await resp.json();
      if (!result.changed) {
        setStatus(
          "No land in the way \u2014 route already clear. Nothing changed.",
          "ok"
        );
        return;
      }
      await client.route.replace(selectedRouteId, result.points);
      const added = result.points.length - selectedRoute.points.length;
      setStatus(
        `Route updated: ${added} via-point${added === 1 ? "" : "s"} added to avoid land. Review it on the chart, then save.`,
        "ok"
      );
      await refreshSelected();
    } catch (err) {
      setStatus(`Auto route failed: ${err.message}`, "error");
    } finally {
      byId("autoRoute").disabled = false;
    }
  }
  async function saveRoute() {
    if (!selectedRouteId) {
      setStatus("Select a route to save.", "warn");
      return;
    }
    setStatus("Saving route\u2026");
    try {
      const { href } = await client.route.save(selectedRouteId, { dialog: true });
      setStatus(`Route saved (${esc(href)}).`, "ok");
    } catch (err) {
      if (reasonOf(err) === "routes.saveCancelled") {
        setStatus("Save cancelled \u2014 route is still unsaved.");
      } else {
        setStatus(`Save failed: ${err.message}`, "error");
      }
    }
  }
  async function main() {
    const root = byId("root");
    client = await connectExtension();
    if (client.hasCapability("units")) {
      try {
        const u = await client.call("units.get", {});
        units = u && u.units ? u.units : null;
      } catch {
        units = null;
      }
    }
    const unit = distanceUnit();
    const defaultClearance = unit === "ft" ? 165 : 50;
    root.innerHTML = `
    <p class="caveat">${esc(SAFETY_CAVEAT)}</p>
    <label class="row" id="routeRow"><span>Route</span>
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
    <p class="status" id="status"></p>`;
    byId("routeSelect").addEventListener("change", onSelectChange);
    byId("autoRoute").addEventListener("click", () => {
      void autoRoute();
    });
    byId("saveRoute").addEventListener("click", () => {
      void saveRoute();
    });
    byId("refresh").addEventListener("click", () => {
      void refreshList();
    });
    await client.subscribe(["route.**"], (name, params) => {
      if (name === "route.visible") {
        upsertVisible(params);
        syncUi();
      } else if (name === "route.hidden") {
        const e = params;
        const wasSelected = e.routeId === selectedRouteId;
        visibleRoutes = visibleRoutes.filter((r) => r.routeId !== e.routeId);
        syncUi();
        if (wasSelected && !selectedRouteId) {
          setStatus("The selected route is no longer visible.");
        }
      } else if (name === "route.saved") {
        const e = params;
        patchVisible(e.routeId, {
          name: e.name,
          saved: e.saved,
          dirty: e.dirty
        });
        syncUi();
      } else if (name === "route.dirty") {
        const e = params;
        patchVisible(e.routeId, { dirty: true });
        syncUi();
      }
    });
    await refreshList();
  }
  main().catch((err) => {
    const root = document.getElementById("root");
    if (root) root.textContent = `Host connection failed: ${err.message}`;
    console.warn("auto-route panel:", err);
  });
})();
//# sourceMappingURL=panel.js.map
