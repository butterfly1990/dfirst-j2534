'use strict'

class DFirstJ2534Error extends Error {
  constructor(message, { code = 0, source = 'dfirst', cause } = {}) {
    super(message)
    this.name = 'DFirstJ2534Error'
    this.code = code
    this.source = source
    if (cause) this.cause = cause
  }
}

module.exports = { DFirstJ2534Error }
