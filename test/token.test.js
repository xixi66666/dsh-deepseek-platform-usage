import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseTokenFile } from '../lib/plugin.js'

test('读取 Python 版 token.json', () => {
  const result = parseTokenFile(JSON.stringify({ user_token: 'abcdefghijklmnop', saved_at: '2026-10-26T14:00:00' }))
  assert.equal(result.error, null)
  assert.equal(result.token, 'abcdefghijklmnop')
})

test('读取浏览器 localStorage 包装', () => {
  const result = parseTokenFile(JSON.stringify({ value: 'tok_0123456789', __version: '0' }))
  assert.equal(result.token, 'tok_0123456789')
})

test('读取裸 token 文本并去掉 Bearer 前缀', () => {
  assert.equal(parseTokenFile('Bearer abcdefghijklmnop').token, 'abcdefghijklmnop')
  assert.equal(parseTokenFile('  abcdefghijklmnop  \r\n').token, 'abcdefghijklmnop')
  assert.equal(parseTokenFile('"abcdefghijklmnop"').token, 'abcdefghijklmnop')
})

test('拒绝空文件与不含凭证的 JSON', () => {
  assert.equal(parseTokenFile('').error, '文件为空')
  assert.equal(parseTokenFile('   ').error, '文件为空')
  assert.equal(parseTokenFile('{"foo":1}').error, '文件里没有可用的 token')
  assert.equal(parseTokenFile('{"value":""}').error, '文件里没有可用的 token')
  assert.equal(parseTokenFile('{"value":"short"}').error, '文件里没有可用的 token')
})
