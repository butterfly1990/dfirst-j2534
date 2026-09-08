'use strict'

const crc32ieee = require('crc/crc32')
const { BLE } = require('./constants')

function crc32(buf) {
  const aligned = Buffer.alloc(Math.ceil(buf.length / 4) * 4)
  buf.copy(aligned)
  return crc32ieee(aligned) >>> 0
}

/** Firmware BLEDL RLE: 2-byte BE original length + first byte + run encoding. */
function compress(data) {
  if (!data.length) {
    return Buffer.from(data)
  }
  const out = [data.length >> 8, data.length & 0xff, data[0]]
  let last = data[0]
  for (let i = 1; i < data.length; i++) {
    if (out.length >= data.length) {
      return Buffer.from(data)
    }
    out.push(data[i])
    const prev = last
    last = data[i]
    let same = 0
    let j = i
    for (; j < data.length && prev === data[j] && same < 0xff; j++) {
      same++
      last = data[j]
    }
    if (j !== i) {
      out.push(same - 1)
      i = j - 1
    }
  }
  if (out.length >= data.length) {
    return Buffer.from(data)
  }
  return Buffer.from(out)
}

function decompress(src) {
  if (!src || src.length <= 2) {
    return Buffer.alloc(0)
  }
  const original = (src[0] << 8) | src[1]
  const out = []
  let last = src[2]
  out.push(last)
  for (let i = 3; i < src.length; i++) {
    out.push(src[i])
    const prev = last
    last = src[i]
    if (prev === src[i] && i + 1 < src.length) {
      const cnt = src[++i]
      for (let n = 0; n < cnt; n++) {
        out.push(prev)
      }
    }
  }
  return out.length === original ? Buffer.from(out) : Buffer.from(out)
}

function encodeHeader({ length, frameNo = 0, type = BLE.FrameType.DATA, crc = false, compress = false, encrypt = false }) {
  const buf = Buffer.alloc(3)
  buf[0] = (length >> 8) & 0x1f
  buf[1] = length & 0xff
  buf[2] = ((type & 3) << 6)
    | (crc ? 0x20 : 0)
    | (compress ? 0x10 : 0)
    | (encrypt ? 0x08 : 0)
    | (frameNo & 7)
  return buf
}

function decodeHeader(buf) {
  const length = ((buf[0] & 0x1f) << 8) | buf[1]
  const st = buf[2]
  return {
    length,
    packageIndex: buf[0] >> 5,
    frameNo: st & 7,
    encrypt: !!(st & 0x08),
    compress: !!(st & 0x10),
    crc: !!(st & 0x20),
    type: st >> 6
  }
}

function frameSize(header) {
  return 3 + header.length + (header.crc ? 4 : 0)
}

function encodeFrame({ payload, frameNo, type = BLE.FrameType.DATA, tryCompress = true }) {
  let body = Buffer.from(payload || [])
  let compressed = false
  if (tryCompress && type === BLE.FrameType.DATA && body.length > BLE.COMPRESS_MIN) {
    const cmp = compress(body)
    if (cmp.length < body.length) {
      body = cmp
      compressed = true
    }
  }
  const needCrc = type === BLE.FrameType.DATA && body.length > BLE.CRC_MIN
  const header = encodeHeader({
    length: body.length,
    frameNo,
    type,
    crc: needCrc,
    compress: compressed
  })
  let frame = Buffer.concat([header, body])
  if (needCrc) {
    const sum = crc32(frame)
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE(sum, 0)
    frame = Buffer.concat([frame, crcBuf])
  }
  return frame
}

function encodeAck(frameNo, code = BLE.Ack.OK) {
  return Buffer.concat([
    encodeHeader({ length: 1, frameNo, type: BLE.FrameType.ACK }),
    Buffer.from([code & 0xff])
  ])
}

function decodeFrame(buf) {
  if (!buf || buf.length < 3) {
    return null
  }
  const header = decodeHeader(buf)
  const total = frameSize(header)
  if (buf.length < total) {
    return null
  }
  const raw = buf.slice(0, total)
  let body = Buffer.from(raw.slice(3, 3 + header.length))
  if (header.crc) {
    const got = raw.readUInt32BE(3 + header.length)
    const calc = crc32(raw.slice(0, 3 + header.length))
    if (got !== calc) {
      header.crcError = true
    }
  }
  if (header.compress && !header.crcError) {
    body = decompress(body)
  }
  return { header, body, raw, total }
}

module.exports = {
  crc32,
  compress,
  decompress,
  encodeHeader,
  decodeHeader,
  frameSize,
  encodeFrame,
  encodeAck,
  decodeFrame
}
