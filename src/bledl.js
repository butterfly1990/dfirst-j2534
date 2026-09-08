'use strict'

const EventEmitter = require('events')
const { BLE } = require('./constants')
const { DFirstJ2534Error } = require('./errors')
const codec = require('./bledl-codec')
const { BleGatt, parseBlecfg } = require('./ble-gatt')
const { deviceCodeFromName } = require('./proVersion')

const MAX_PACKAGE_CNT = 7
const PACKAGE_TIMEOUT_MS = 400

/** blecfg: service-write-read-notify-maxPagLen-MTU (all hex)
 *  JDY framing when maxPagLen < mtu (A0/A1 only)
 *  A2–A4: slice by mtu-12, no package sequence header
 */
const BLECFG_BY_CODE = {
  A0: 'FFE0-FFE1-FFE1-FFE1-14-20',
  A1: 'FFE0-FFE1-FFE1-FFE1-14-20',
  A2: 'FFE1-FFE3-FFE1-FFE2-200-D4',
  A3: 'FFE1-FFE3-FFE1-FFE2-200-D4',
  A4: 'FFE1-FFE3-FFE1-FFE2-200-D4',
  /** B0 与早期 A 系列同类模块（无官方表时按 JDY） */
  B0: 'FFE0-FFE1-FFE1-FFE1-14-20',
  /** V2 机型也走 BLEDL，但 GATT/分包不同 */
  A5: 'FFE1-FFE3-FFE1-FFE2-2000-D4',
  A6: 'FFE1-FFE3-FFE1-FFE2-2000-D4',
  C0: 'FEE0-FEE1-FEE2-FEE2-200-C0'
  // S0/S1/S2：ESP32 AT 默认 A002/C304/C305，不强制 blecfg，靠 PROFILES
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function inferBlecfg(name, serviceHints) {
  const code = deviceCodeFromName(name)
  if (code && BLECFG_BY_CODE[code]) return BLECFG_BY_CODE[code]
  const hints = (serviceHints || []).map((s) => String(s).toLowerCase())
  if (hints.includes('ffe0')) return BLECFG_BY_CODE.A1
  if (hints.includes('ffe1')) return BLECFG_BY_CODE.A2
  if (hints.includes('fee0')) return BLECFG_BY_CODE.C0
  return ''
}

/** 只读摘要，便于测试页/日志 */
function bleLinkSummary(blecfg) {
  const cfg = parseBlecfg(blecfg)
  if (!cfg) {
    return { blecfg: '', jdy: false, mxPackLen: BLE.WRITE_MAX, mtu: 0xc0, chunk: BLE.WRITE_MAX }
  }
  const jdy = cfg.maxPagLen < cfg.mtu
  const chunk = jdy
    ? cfg.maxPagLen
    : Math.max(20, Math.min(cfg.mtu - (BLE.MTU_HEAD || 12), cfg.maxPagLen || 0x2000))
  return {
    blecfg,
    service: cfg.service,
    write: cfg.write,
    notify: cfg.notify,
    jdy,
    mxPackLen: cfg.maxPagLen,
    mtu: cfg.mtu,
    chunk
  }
}

/**
 * BLEDL link: 3-byte header, optional compress/CRC, GATT chunking, ACK.
 * A0/A1 (JDY): when mxPackLen < mtu, each GATT packet has a sequence header.
 */
class BledlLink extends EventEmitter {
  constructor(options = {}) {
    super()
    this.options = options
    this.gatt = options.gatt || new BleGatt(options)
    this.timeout = options.timeout || 5000
    this._frameNo = 0
    this._queue = Promise.resolve()
    this._frames = []
    this._waiters = []
    this.info = null
    this._jdyCach = []
    this._jdyFrameSize = 0
    this._jdyHasCrc = false
    this._jdyTimer = null
    this._buf = Buffer.alloc(0)
    this._applyLinkCfg(options.blecfg)

    this.gatt.on('data', (chunk) => this._onData(chunk))
    this.gatt.on('close', () => this.emit('close'))
    this.gatt.on('discover', (dev) => this.emit('discover', dev))
    this.gatt.on('trace', (msg) => this.emit('trace', msg))
  }

  get connected() {
    return this.gatt.connected
  }

  _applyLinkCfg(blecfg) {
    const cfg = parseBlecfg(blecfg)
    // mxPackLen < mtu → JDY framing; otherwise slice by MTU-12 (A2–A4/C0/A5)
    this.mxPackLen = (cfg && cfg.maxPagLen) || BLE.WRITE_MAX
    this.mtu = (cfg && cfg.mtu) || 0xc0
    this.jdyPack = !!(cfg && this.mxPackLen < this.mtu)
    const mtuPayload = Math.max(20, this.mtu - (BLE.MTU_HEAD || 12))
    this.chunk = this.jdyPack
      ? this.mxPackLen
      : Math.min(mtuPayload, this.mxPackLen > 0 ? this.mxPackLen : mtuPayload)
    if (cfg) {
      this.gatt.profile = cfg
      this.gatt.options.blecfg = blecfg
    }
  }

  scan(opts) {
    return this.gatt.scan(opts)
  }

  async connect(target) {
    const t = target && typeof target === 'object' ? target : { id: target }
    const name = t.name || this.options.name || ''
    const hints = t.serviceHints || []
    if (!this.options.blecfg && !this.gatt.profile) {
      const auto = inferBlecfg(name, hints)
      if (auto) {
        this.options.blecfg = auto
        this._applyLinkCfg(auto)
        this.emit('trace', `blecfg auto ${auto}`)
      }
    } else if (this.options.blecfg) {
      this._applyLinkCfg(this.options.blecfg)
    }

    this.info = await this.gatt.connect({
      name: t.name || this.options.name,
      id: t.id || this.options.deviceId || this.options.id,
      namePrefix: t.namePrefix || this.options.namePrefix || BLE.NAME_PREFIX,
      timeout: t.timeout || this.options.scanTimeout || 15000,
      serviceHints: hints
    })
    // 连上后若仍无 blecfg，按广播名再推断一次
    if (!this.options.blecfg && this.info && this.info.name) {
      const auto = inferBlecfg(this.info.name, this.info.gatt && [this.info.gatt.service])
      if (auto) {
        this.options.blecfg = auto
        this._applyLinkCfg(auto)
        this.emit('trace', `blecfg post-connect ${auto}`)
      }
    }
    this._resetRx()
    this.emit('connected', this.info)
    return this.info
  }

  async close() {
    await this.gatt.close()
    this._resetRx()
    for (const waiter of this._waiters) {
      clearTimeout(waiter.timer)
    }
    this._waiters = []
  }

  _resetRx() {
    this._frames = []
    this._buf = Buffer.alloc(0)
    this._jdyCach = []
    this._jdyFrameSize = 0
    this._jdyHasCrc = false
    if (this._jdyTimer) {
      clearTimeout(this._jdyTimer)
      this._jdyTimer = null
    }
  }

  /** JDY package count when mxPackLen=20 */
  _calcJdyPackageCnt(len) {
    const mx = this.mxPackLen
    if (len < mx) return 1
    return Math.floor((len - mx) / (mx - 1)) + 2
  }

  _packageJdy(frame) {
    const mx = this.mxPackLen
    const cnt = this._calcJdyPackageCnt(frame.length)
    const packs = []
    packs.push(Buffer.from(frame.slice(0, Math.min(frame.length, mx))))
    const sig = mx - 1
    for (let i = 0; i < cnt - 1; i++) {
      const idx = (((i % MAX_PACKAGE_CNT) + 1) << 5) & 0xff
      const offset = i * sig + mx
      if (frame.length > offset) {
        const n = Math.min(frame.length - offset, sig)
        packs.push(Buffer.concat([Buffer.from([idx]), frame.slice(offset, offset + n)]))
      } else {
        packs.push(Buffer.from([idx, 0x00]))
      }
    }
    return packs
  }

  /** Send J2534 command bytes, wait ACK then DATA response. */
  request(payload, timeout) {
    const run = () => this._request(payload, timeout)
    const next = this._queue.then(run, run)
    this._queue = next.catch(() => {})
    return next
  }

  async _request(payload, timeout) {
    if (!this.connected) {
      throw new DFirstJ2534Error('ble not connected', { source: 'ble' })
    }
    const frameNo = this._frameNo & 7
    this._frameNo = (this._frameNo + 1) & 7
    const frame = codec.encodeFrame({ payload, frameNo, type: BLE.FrameType.DATA })

    let lastErr
    for (let attempt = 0; attempt < BLE.RETRY; attempt++) {
      try {
        this._resetRx()
        const ackWait = this._waitFrame((f) => f.header.type === BLE.FrameType.ACK, BLE.ACK_TIMEOUT)
        this.emit('trace', `tx ${frame.toString('hex')} attempt ${attempt + 1}`)
        await this._writeFrame(frame)
        const ack = await ackWait
        this.emit('trace', `ack ${ack.body.toString('hex')}`)
        if (ack.header.frameNo !== frameNo) {
          throw new DFirstJ2534Error(`ble ack frame ${ack.header.frameNo} != ${frameNo}`, { source: 'ble' })
        }
        if (ack.body[0]) {
          throw new DFirstJ2534Error(`ble ack ${ack.body[0]}`, { code: ack.body[0], source: 'ble' })
        }
        const data = await this._waitFrame(
          (f) => f.header.type === BLE.FrameType.DATA,
          timeout || this.timeout
        )
        await this._writeFrame(codec.encodeAck(data.header.frameNo, BLE.Ack.OK))
        return data.body
      } catch (err) {
        lastErr = err
        this.emit('trace', `ble attempt fail: ${(err && err.message) || err}`)
      }
    }
    throw lastErr || new DFirstJ2534Error('ble request failed', { source: 'ble' })
  }

  async _writeFrame(frame) {
    if (this.jdyPack) {
      const packs = this._packageJdy(frame)
      this.emit('trace', `jdy packs ${packs.length} mx=${this.mxPackLen}`)
      for (const p of packs) {
        await this.gatt.write(p)
        await delay(8)
      }
      return
    }
    // A2–A4 / C0：按 MTU-12 切片，片间稍作间隔（对齐微信小程序连续写）
    const size = Math.max(20, this.chunk)
    for (let i = 0; i < frame.length; i += size) {
      await this.gatt.write(frame.slice(i, i + size))
      if (i + size < frame.length) await delay(4)
    }
  }

  _waitFrame(pred, timeout) {
    for (let i = 0; i < this._frames.length; i++) {
      if (pred(this._frames[i])) {
        return Promise.resolve(this._frames.splice(i, 1)[0])
      }
    }
    return new Promise((resolve, reject) => {
      const waiter = { pred, resolve, timer: null }
      waiter.timer = setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w !== waiter)
        reject(new DFirstJ2534Error('ble frame timeout', { source: 'ble' }))
      }, timeout)
      this._waiters.push(waiter)
    })
  }

  _deliverFrame(raw) {
    const parsed = codec.decodeFrame(raw)
    if (!parsed || parsed.header.crcError) {
      return
    }
    this.emit('trace', `rx type=${parsed.header.type} n=${parsed.header.frameNo} len=${parsed.body.length} ${parsed.body.toString('hex').slice(0, 128)}`)
    const idx = this._waiters.findIndex((w) => w.pred(parsed))
    if (idx >= 0) {
      const waiter = this._waiters.splice(idx, 1)[0]
      clearTimeout(waiter.timer)
      waiter.resolve(parsed)
    } else {
      this._frames.push(parsed)
    }
  }

  _onData(chunk) {
    if (this.jdyPack) {
      this._onJdyPackage(Buffer.from(chunk))
      return
    }
    this._buf = Buffer.concat([this._buf || Buffer.alloc(0), chunk])
    while (this._buf.length >= 3) {
      const header = codec.decodeHeader(this._buf)
      if (header.packageIndex) {
        // 非 JDY 模式不应出现包序号；丢弃错位
        this._buf = this._buf.slice(1)
        continue
      }
      const total = codec.frameSize(header)
      if (this._buf.length < total) {
        return
      }
      const raw = this._buf.slice(0, total)
      this._buf = this._buf.slice(total)
      this._deliverFrame(raw)
    }
  }

  _jdyAssemble() {
    if (!this._jdyCach.length || !this._jdyCach[0] || this._jdyCach[0].length < 3) {
      return null
    }
    const dataLen = this._jdyFrameSize + 3 + (this._jdyHasCrc ? 4 : 0)
    let temp = Buffer.from(this._jdyCach[0])
    for (let i = 1; i < this._jdyCach.length; i++) {
      const p = this._jdyCach[i]
      if (!p || !p.length) return null
      temp = Buffer.concat([temp, p.slice(1)])
    }
    if (temp.length < dataLen) return null
    return temp.slice(0, dataLen)
  }

  _onJdyPackage(buf) {
    if (!buf.length) return
    if (this._jdyTimer) {
      clearTimeout(this._jdyTimer)
      this._jdyTimer = null
    }
    const high = buf[0] & 0xe0
    const isFirst = high === 0

    if (isFirst) {
      if (buf.length < 3) return
      this._jdyFrameSize = ((buf[0] & 0x1f) << 8) | buf[1]
      this._jdyHasCrc = !!(buf[2] & 0x20)
      const totalSize = this._jdyFrameSize + 3 + (this._jdyHasCrc ? 4 : 0)
      const cnt = this._calcJdyPackageCnt(totalSize)
      this._jdyCach = new Array(cnt).fill(null)
      this._jdyCach[0] = Buffer.from(buf)
      if (cnt === 1 && buf.length >= totalSize) {
        const raw = this._jdyAssemble()
        this._jdyCach = []
        if (raw) this._deliverFrame(raw)
        return
      }
    } else {
      if (!this._jdyCach.length) {
        return
      }
      const currentIndex = (buf[0] & 0xe0) >> 5
      let nextCnt = this._jdyCach.length - 1
      for (let i = 0; i < this._jdyCach.length; i++) {
        if (this._jdyCach[this._jdyCach.length - i - 1] && this._jdyCach[this._jdyCach.length - i - 1].length) {
          nextCnt = this._jdyCach.length - i
          break
        }
      }
      let placed = false
      for (let i = 0; i < this._jdyCach.length; i++) {
        let tempCnt = nextCnt % MAX_PACKAGE_CNT
        tempCnt = tempCnt === 0 ? MAX_PACKAGE_CNT : tempCnt
        if (tempCnt === currentIndex && nextCnt < this._jdyCach.length) {
          this._jdyCach[nextCnt] = Buffer.from(buf)
          placed = true
          break
        }
        nextCnt++
      }
      if (!placed) {
        this.emit('trace', `jdy drop pkg idx=${currentIndex}`)
        return
      }
      // Last packet shorter than mxPackLen → frame complete
      if (buf.length !== this.mxPackLen) {
        const raw = this._jdyAssemble()
        this._jdyCach = []
        if (raw) this._deliverFrame(raw)
        return
      }
    }

    const raw = this._jdyAssemble()
    if (raw) {
      this._jdyCach = []
      this._deliverFrame(raw)
      return
    }

    this._jdyTimer = setTimeout(() => {
      this._jdyTimer = null
      this._jdyCach = []
      this.emit('trace', 'jdy package timeout')
    }, PACKAGE_TIMEOUT_MS)
  }
}

module.exports = { BledlLink, inferBlecfg, BLECFG_BY_CODE, bleLinkSummary }
