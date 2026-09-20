import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const script = join(import.meta.dirname, 'check-index-size.mjs')
const home = mkdtempSync(join(tmpdir(), 'lcode-index-size-'))

try {
  mkdirSync(join(home, 'sessions'))
  writeFileSync(join(home, 'sessions', 'one.jsonl'), 'x'.repeat(1000))
  writeFileSync(join(home, 'index.db'), 'x'.repeat(100))
  let result = run(home)
  assert.equal(result.status, 0)
  assert.match(result.stdout, /索引\/日志：10\.00%/)
  assert.match(result.stdout, /小样本门槛/)

  writeFileSync(join(home, 'index.db'), 'x'.repeat(512 * 1024 + 1))
  result = run(home)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /超过 524288 bytes 预算/)

  writeFileSync(join(home, 'sessions', 'one.jsonl'), 'x'.repeat(1024 * 1024))
  writeFileSync(join(home, 'index.db'), 'x'.repeat(Math.floor(1024 * 1024 * 0.15)))
  result = run(home)
  assert.equal(result.status, 0)
  assert.doesNotMatch(result.stdout, /小样本门槛/)

  writeFileSync(join(home, 'index.db'), 'x'.repeat(Math.floor(1024 * 1024 * 0.16)))
  result = run(home)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /超过日志体积的 15%/)

  rmSync(join(home, 'sessions'), { recursive: true, force: true })
  result = run(home)
  assert.equal(result.status, 0)
  assert.match(result.stdout, /无日志时仅记录空基线/)
  console.log('check-index-size tests passed')
} finally {
  rmSync(home, { recursive: true, force: true })
}

function run(lcodeHome) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, LCODE_HOME: lcodeHome },
  })
}
