import assert from 'node:assert/strict'
import { retry } from './src/retry.mjs'

let calls = 0
const value = await retry(async () => {
  calls += 1
  if (calls < 2) throw new Error('temporary')
  return 'ok'
}, 3)
assert.equal(value, 'ok')
assert.equal(calls, 2)

let failures = 0
let last
await assert.rejects(
  () => retry(async () => {
    failures += 1
    last = new Error(`failure-${failures}`)
    throw last
  }, 2),
  (error) => error === last,
)
assert.equal(failures, 2)

await assert.rejects(() => retry(async () => 1, 0), TypeError)
await assert.rejects(() => retry(async () => 1, -1), TypeError)
await assert.rejects(() => retry(async () => 1, 1.5), TypeError)
console.log('ok')
