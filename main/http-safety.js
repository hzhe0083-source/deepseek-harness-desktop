'use strict'

function hasSameOrigin (candidate, trusted) {
  try {
    return new URL(candidate).origin === new URL(trusted).origin
  } catch {
    return false
  }
}

function isSuccessfulHtmlResponse (statusCode, contentType) {
  return statusCode === 200 && /^text\/html(?:\s*;|\s*$)/i.test(String(contentType || ''))
}

module.exports = {
  hasSameOrigin,
  isSuccessfulHtmlResponse
}
