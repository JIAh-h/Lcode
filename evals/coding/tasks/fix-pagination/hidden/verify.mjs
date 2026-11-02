import assert from 'node:assert/strict'
import { paginate } from './src/paginate.mjs'

const items = [1, 2, 3, 4, 5]
assert.deepEqual(paginate(items, 1, 2), [1, 2])
assert.deepEqual(paginate(items, 2, 2), [3, 4])
assert.deepEqual(paginate(items, 3, 2), [5])
assert.deepEqual(paginate(items, 4, 2), [])
assert.deepEqual(paginate([1, 2, 3], 1, 10), [1, 2, 3])
assert.deepEqual(paginate([], 1, 3), [])
assert.deepEqual(paginate(items, 1, 1), [1])
console.log('ok')
