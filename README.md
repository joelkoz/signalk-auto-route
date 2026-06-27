# signalk-auto-route

Land-avoidance auto-routing for Signal K chartplotters.

Draw a route on the chart, open the **Auto Route** toolbar button, set a
clearance margin, and press **Auto route**. The plugin looks at each leg of
your route and, wherever the straight line would cross charted land, inserts
waypoints that steer around it — leaving the legs that are already clear, and
your own deliberate waypoints, untouched. The result appears on the chart as a
live, editable route for you to review and then save.

> ⚠️ **Avoids charted land only — not depth, shoals, rocks, or other hazards.**
> This is a convenience to save you dragging waypoints around an island, **not**
> a navigation-safety planner. Always review the route before navigating.

## What it needs

- A chartplotter that supports the Signal K plotter extensions **routes**
  capability (e.g. **Freeboard-SK**). If your chartplotter doesn't, the Auto
  Route button simply won't appear.
- A **vector chart** for the area, containing a land layer (`LNDARE`). These
  are the S-57 / `pbf` MBTiles charts produced by, for example,
  [`signalk-charts-provider-simple`](https://www.npmjs.com/package/signalk-charts-provider-simple)
  (recommended, but not required — any vector chart with an `LNDARE` layer
  works). Raster charts (PNG/JPEG tiles) cannot be used — there is no land
  geometry to read from them.

If there is no vector chart covering the waters of your route, Auto Route tells
you so and changes nothing.

## How to use it

1. Install and enable the plugin from the Signal K App Store (or `npm`).
2. In your chartplotter, draw a route across the water as usual.
3. Tap the **Auto Route** toolbar button to open its panel.
4. Set the **clearance** — how far off land you want to stay (default 50 m).
5. Press **Auto route**. Waypoints are inserted around any land in the way.
6. Review the new route on the chart. If you like it, save it with your
   chartplotter's normal save action; if not, undo or discard it.

## Settings

| Setting               | What it does                                                       |
| --------------------- | ----------------------------------------------------------------- |
| Land layer name       | Vector-tile layer holding land polygons. Default `LNDARE` (S-57). |
| Chart directory       | Optional override for where to look for `.mbtiles` charts.        |
| Bounding-box padding  | How far beyond the route to read land tiles (degrees).            |

## Limitations

- Avoids **charted land only**. It knows nothing about water depth, rocks,
  shoals, restricted areas, traffic, or weather.
- Uses the land shapes from your vector charts at their highest detail level;
  very small islands that a chart omits at that level will not be avoided.
- In this version, land that straddles a chart-tile boundary is handled
  approximately; on rare occasions a route may pass closer to such a feature
  than expected. Always review the result.

## Licence

MIT © Joel Kozikowski
