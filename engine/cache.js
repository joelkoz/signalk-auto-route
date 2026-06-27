// Tiny LRU cache keyed by a string (e.g. `chartId|bboxQuantized|zoom`).
//
// ZERO external dependencies. Used to memoise stitched land polygons / derived
// visibility data so repeat routing in the same waters reuses the obstacle set
// (acceptance criterion 6). Most-recently-used is moved to the back of the
// insertion order; eviction drops the least-recently-used (front).

'use strict'

class LRUCache {
  constructor(maxSize = 16) {
    if (!(maxSize > 0)) throw new Error('LRUCache maxSize must be > 0')
    this.maxSize = maxSize
    this._map = new Map() // Map preserves insertion order → LRU is re=insert.
    this.hits = 0
    this.misses = 0
  }

  get size() {
    return this._map.size
  }

  has(key) {
    return this._map.has(key)
  }

  /** Returns the cached value (and marks it MRU), or undefined on a miss. */
  get(key) {
    if (!this._map.has(key)) {
      this.misses++
      return undefined
    }
    this.hits++
    const value = this._map.get(key)
    // Re-insert to move to MRU position.
    this._map.delete(key)
    this._map.set(key, value)
    return value
  }

  /** Insert/update; evicts the LRU entry if over capacity. */
  set(key, value) {
    if (this._map.has(key)) this._map.delete(key)
    this._map.set(key, value)
    if (this._map.size > this.maxSize) {
      const oldest = this._map.keys().next().value
      this._map.delete(oldest)
    }
    return this
  }

  delete(key) {
    return this._map.delete(key)
  }

  clear() {
    this._map.clear()
    this.hits = 0
    this.misses = 0
  }

  keys() {
    return [...this._map.keys()]
  }
}

module.exports = { LRUCache }
