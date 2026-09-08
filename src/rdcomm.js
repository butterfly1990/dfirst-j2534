'use strict'

const net = require('net')
const EventEmitter = require('events')
const crc32mpeg2 = require('crc/crc32mpeg2')
const { RDCOMM } = require('./constants')
const { DFirstJ2534Error } = require('./errors')

function crc32(buf) {
  const aligned = Buffer.alloc(Math.ceil(buf.length / 4) * 4)
  buf.copy(aligned)
  return crc32mpeg2(aligned) >>> 0
}

class RdcommClient extends EventEmitter {
  constructor(options = {}) {
    super()
    this.host = options.host
    this.port = options.port || RDCOMM.PORT
    this.timeout = options.timeout || 5000
    this.socket = null
    this._buf = Buffer.alloc(0)
    this._index = 0
    this._pending = new Map()
  }

  get connected() {
    return !!this.socket
  }

  connect() {
    if (this.socket) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port })
      const onError = (err) => {
        socket.destroy()
        reject(err)
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.off('error', onError)
        this.socket = socket
        socket.on('data', (chunk) => this._onData(chunk))
        socket.on('close', () => this._onClose())
        socket.on('error', (err) => this.emit('error', err))
        resolve()
      })
    })
  }

  close() {
    for (const [index, pending] of this._pending) {
      clearTimeout(pending.timer)
      pending.reject(new DFirstJ2534Error(`connection closed, index=${index}`, { source: 'rdcomm' }))
    }
    this._pending.clear()
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
  }

  send(command, data, options = {}) {
    if (!this.socket) {
      return Promise.reject(new DFirstJ2534Error('not connected', { source: 'rdcomm' }))
    }
    const noAck = !!options.noAck
    const timeout = options.timeout || this.timeout
    const payload = data ? Buffer.from(data) : Buffer.alloc(0)
    const index = (++this._index) & 0xffff
    const frame = this._encode(command, payload, { index, noAck, ack: false })

    if (noAck) {
      this.socket.write(frame)
      return Promise.resolve(null)
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(index)
        reject(new DFirstJ2534Error(`timeout cmd=0x${command.toString(16)}`, { source: 'rdcomm' }))
      }, timeout)
      this._pending.set(index, { resolve, reject, timer })
      this.socket.write(frame)
    })
  }

  _encode(command, payload, { index, noAck, ack, error }) {
    const bodyLen = payload.length
    const frame = Buffer.alloc(RDCOMM.HEADER_LEN + bodyLen + 4)
    frame.writeUInt32BE(RDCOMM.MAGIC, 0)
    frame.writeUInt32LE(bodyLen, 4)
    let flags = 0
    if (ack) flags |= 0x80
    if (noAck) flags |= 0x08
    frame.writeUInt8(flags, 8)
    frame.writeUInt8(ack ? (error || 0) : command, 9)
    frame.writeUInt16LE(index, 10)
    if (bodyLen) {
      payload.copy(frame, 12)
    }
    const crc = crc32(frame.slice(0, 12 + bodyLen))
    frame.writeUInt32LE(crc, 12 + bodyLen)
    return frame
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk])
    while (this._buf.length >= RDCOMM.MIN_FRAME) {
      const magicLe = this._buf.readUInt32LE(0)
      const magicBe = this._buf.readUInt32BE(0)
      if (magicBe !== RDCOMM.MAGIC && magicLe !== 0xFFFFFE01) {
        this._buf = Buffer.alloc(0)
        return
      }
      const length = this._buf.readUInt32LE(4)
      const total = length + 16
      if (this._buf.length < total) {
        return
      }
      const frame = this._buf.slice(0, total)
      this._buf = this._buf.slice(total)
      this._handleFrame(frame)
    }
  }

  _handleFrame(frame) {
    const length = frame.readUInt32LE(4)
    const flags = frame.readUInt8(8)
    const isAck = !!(flags & 0x80)
    const noAck = !!(flags & 0x08)
    const hasService = !!(flags & 0x10)
    const commandOrError = frame.readUInt8(9)
    const index = frame.readUInt16LE(10)
    let offset = 12
    if (hasService) {
      offset += 4
    }
    const dataLen = Math.max(0, 12 + length - offset)
    const data = dataLen > 0 ? Buffer.from(frame.slice(offset, offset + dataLen)) : Buffer.alloc(0)

    if (isAck) {
      const pending = this._pending.get(index)
      if (pending) {
        clearTimeout(pending.timer)
        this._pending.delete(index)
        if (commandOrError && commandOrError !== RDCOMM.RE.NoError) {
          pending.reject(new DFirstJ2534Error(`rdcomm 0x${commandOrError.toString(16)}`, {
            code: commandOrError,
            source: 'rdcomm'
          }))
        } else {
          pending.resolve({ error: commandOrError, data })
        }
      }
      return
    }

    if (!noAck && this.socket) {
      this.socket.write(this._encode(0, Buffer.alloc(0), {
        index,
        ack: true,
        error: RDCOMM.RE.NoError,
        noAck: false
      }))
    }

    this.emit('event', { command: commandOrError, data, index, noAck })
  }

  _onClose() {
    this.socket = null
    this.emit('close')
    for (const [index, pending] of this._pending) {
      clearTimeout(pending.timer)
      pending.reject(new DFirstJ2534Error(`socket closed, index=${index}`, { source: 'rdcomm' }))
    }
    this._pending.clear()
  }
}

module.exports = RdcommClient
