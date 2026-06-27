'use strict'

const { test } = require('node:test')
const assert = require('node:assert')

const { LRUCache } = require('../engine/cache')

test('hit and miss accounting', () => {
  const c = new LRUCache(4)
  assert.strictEqual(c.get('a'), undefined)
  assert.strictEqual(c.misses, 1)
  c.set('a', 1)
  assert.strictEqual(c.get('a'), 1)
  assert.strictEqual(c.hits, 1)
})

test('LRU eviction drops least-recently-used', () => {
  const c = new LRUCache(2)
  c.set('a', 1)
  c.set('b', 2)
  c.get('a') // 'a' is now MRU, 'b' is LRU
  c.set('c', 3) // evicts 'b'
  assert.ok(c.has('a'))
  assert.ok(c.has('c'))
  assert.ok(!c.has('b'))
  assert.strictEqual(c.size, 2)
})

test('re-setting an existing key refreshes recency', () => {
  const c = new LRUCache(2)
  c.set('a', 1)
  c.set('b', 2)
  c.set('a', 10) // 'a' refreshed → 'b' is now LRU
  c.set('c', 3) // evicts 'b'
  assert.strictEqual(c.get('a'), 10)
  assert.ok(!c.has('b'))
})

test('clear resets entries and counters', () => {
  const c = new LRUCache(2)
  c.set('a', 1)
  c.get('a')
  c.clear()
  assert.strictEqual(c.size, 0)
  assert.strictEqual(c.hits, 0)
  assert.strictEqual(c.misses, 0)
})

test('maxSize must be positive', () => {
  assert.throws(() => new LRUCache(0))
})
