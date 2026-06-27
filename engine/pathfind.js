// A* shortest path over a visibility graph.
//
// ZERO external dependencies. The graph comes from visibility.js:
//   { nodes: [[lon,lat],...], adj: [[{to,w},...],...] }
// A* uses straight-line (planar) distance to the goal as an admissible
// heuristic. With a small binary-heap priority queue it stays fast for the
// vertex counts this router produces.

'use strict'

const { distance } = require('./geometry')

// Minimal binary min-heap keyed by `f`. Avoids a sorted-array scan so the
// pathfinder scales to the few-hundred-node graphs a busy coastline yields.
class MinHeap {
  constructor() {
    this._a = []
  }
  get size() {
    return this._a.length
  }
  push(item) {
    const a = this._a
    a.push(item)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].f <= a[i].f) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }
  pop() {
    const a = this._a
    const top = a[0]
    const last = a.pop()
    if (a.length > 0) {
      a[0] = last
      let i = 0
      const n = a.length
      for (;;) {
        const l = 2 * i + 1
        const r = 2 * i + 2
        let smallest = i
        if (l < n && a[l].f < a[smallest].f) smallest = l
        if (r < n && a[r].f < a[smallest].f) smallest = r
        if (smallest === i) break
        ;[a[smallest], a[i]] = [a[i], a[smallest]]
        i = smallest
      }
    }
    return top
  }
}

/**
 * A* from node index `startIdx` to `goalIdx`.
 * Returns an array of node indices (inclusive of start and goal) for the
 * shortest path, or null if the goal is unreachable.
 */
function astar(graph, startIdx, goalIdx) {
  const { nodes, adj } = graph
  const n = nodes.length
  const goal = nodes[goalIdx]

  const gScore = new Array(n).fill(Infinity)
  const cameFrom = new Array(n).fill(-1)
  const closed = new Array(n).fill(false)

  gScore[startIdx] = 0
  const open = new MinHeap()
  open.push({ idx: startIdx, f: distance(nodes[startIdx], goal) })

  while (open.size > 0) {
    const { idx } = open.pop()
    if (idx === goalIdx) return reconstruct(cameFrom, goalIdx)
    if (closed[idx]) continue
    closed[idx] = true

    for (const { to, w } of adj[idx]) {
      if (closed[to]) continue
      const tentative = gScore[idx] + w
      if (tentative < gScore[to]) {
        gScore[to] = tentative
        cameFrom[to] = idx
        open.push({ idx: to, f: tentative + distance(nodes[to], goal) })
      }
    }
  }
  return null
}

function reconstruct(cameFrom, goalIdx) {
  const path = [goalIdx]
  let cur = goalIdx
  while (cameFrom[cur] !== -1) {
    cur = cameFrom[cur]
    path.push(cur)
  }
  return path.reverse()
}

module.exports = { astar, MinHeap }
