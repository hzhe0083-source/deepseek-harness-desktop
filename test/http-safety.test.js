'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { hasSameOrigin, isSuccessfulHtmlResponse } = require('../main/http-safety')

test('local navigation requires an exact URL origin match', () => {
  const trusted = 'http://127.0.0.1:43127'
  assert.equal(hasSameOrigin('http://127.0.0.1:43127/chat?id=1', trusted), true)
  assert.equal(hasSameOrigin('http://127.0.0.1:431270/', trusted), false)
  assert.equal(hasSameOrigin('http://127.0.0.1:43127@evil.example/', trusted), false)
  assert.equal(hasSameOrigin('https://127.0.0.1:43127/', trusted), false)
  assert.equal(hasSameOrigin('not a URL', trusted), false)
})

test('readiness accepts only a successful HTML document', () => {
  assert.equal(isSuccessfulHtmlResponse(200, 'text/html; charset=utf-8'), true)
  assert.equal(isSuccessfulHtmlResponse(200, 'TEXT/HTML'), true)
  assert.equal(isSuccessfulHtmlResponse(204, 'text/html'), false)
  assert.equal(isSuccessfulHtmlResponse(404, 'text/html'), false)
  assert.equal(isSuccessfulHtmlResponse(200, 'application/json'), false)
})
