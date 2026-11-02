import assert from 'node:assert/strict'
import { slugify } from './src/slugify.mjs'

assert.equal(slugify('  Hello   World!  '), 'hello-world')
assert.equal(slugify('C++ 与 Node.js'), 'c-与-nodejs')
assert.equal(slugify('中文 标题'), '中文-标题')
assert.equal(slugify('A--B   C'), 'a-b-c')
assert.equal(slugify(''), '')
console.log('ok')
