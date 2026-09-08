'use strict'

const codec = require('./codec')
const { Command } = require('./constants')

function pick(obj, keys, fallback = 0) {
  for (const key of keys) {
    if (obj[key] != null) {
      return obj[key]
    }
  }
  return fallback
}

/**
 * DFirst J2534 protocol API, one method per command ID.
 * Payload path: LAN = RDComm 0x8C; BLE = BLEDL (no RDComm).
 * Encode/decode uses `device.codec` (proVersion V1/V2).
 */
class J2534Protocol {
  constructor(device) {
    this.device = device
  }

  get codec() {
    return this.device.codec || codec
  }

  async _exec(payload, parse, timeout) {
    const data = await this.device.sendJ2534(payload, timeout)
    return parse ? parse(data) : { error: data.readUInt32LE(0), raw: data }
  }

  /** 0x00000001 OPEN — if already open, read version; otherwise try V1/V2 by model */
  async open() {
    if (this.device.opened) {
      return this.readVersion()
    }
    const version = await this.device.passThruOpen()
    return { error: 0, version }
  }

  /** 0x00000002 CLOSE — no request params; returns ErrorCode */
  async close() {
    const res = await this._exec(this.codec.encodeClose(), this.codec.decode.close)
    this.device.opened = false
    return res
  }

  /**
   * 0x00000003 CONNECT — open a physical channel
   * @param {object} opts
   * @param {number} [opts.connectFlags] CAN often uses CAN_ID_BOTH; ETH see DHCP/AUTO_IP
   * @param {number} opts.protocolId Protocol.CAN=5 / ETH=0xFD / ISO9141=3…
   * @param {number} opts.baudRate CAN 500000; K-line 10400
   * @param {number} [opts.pinSelect] high byte = plus, low = minus; OBD CAN=0x060E; 0=default
   */
  connect(opts = {}) {
    return this._exec(this.codec.encodeConnect({
      flags: pick(opts, ['connectFlags', 'flags']),
      protocol: pick(opts, ['protocolId', 'protocol']),
      baud: pick(opts, ['baudRate', 'baud']),
      pinSelect: pick(opts, ['pinSelect'])
    }), this.codec.decode.connect)
  }

  /**
   * 0x00000004 DISCONNECT
   * @param {number} channelId
   */
  disconnect(channelId) {
    return this._exec(this.codec.encodeDisconnect(channelId), this.codec.decode.disconnect)
  }

  /**
   * 0x00000005 READMSG
   * @param {number} channelId
   * @param {object} [opts]
   * @param {number} [opts.msgNum=8] max messages
   * @param {number} [opts.timeout=1000] wait ms; TIMEOUT/BUFFER_EMPTY may still return messages
   */
  readMsg(channelId, opts = {}) {
    const num = pick(opts, ['msgNum', 'num'], 8)
    const timeout = pick(opts, ['timeout'], 1000)
    return this._exec(
      this.codec.encodeRead(channelId, { num, timeout }),
      this.codec.decode.readMsg,
      timeout + 500
    )
  }

  /**
   * 0x00000006 WRITEMSG
   * @param {number} channelId
   * @param {Array<{handle?:number, txFlags?:number, data:Buffer|string}>} msgs
   *   ISO15765 data = canId4(id)[+EA] + UDS
   */
  writeMsg(channelId, msgs) {
    return this._exec(this.codec.encodeWrite(channelId, msgs), this.codec.decode.writeMsg)
  }

  /**
   * 0x00000007 STARTPERIODICMSG
   * @param {number} channelId
   * @param {{ interval:number, handle?:number, txFlags?:number, data:Buffer|string }} msg
   *   interval = period ms; data fills the 12-byte periodic slot
   */
  startPeriodicMsg(channelId, msg) {
    return this._exec(this.codec.encodeStartPeriodic(channelId, msg), this.codec.decode.startPeriodicMsg)
  }

  /** 0x00000008 STOPPERIODICMSG @param {number} msgId */
  stopPeriodicMsg(channelId, msgId) {
    return this._exec(this.codec.encodeStopPeriodic(channelId, msgId), this.codec.decode.stopPeriodicMsg)
  }

  /**
   * 0x00000009 STARTMSGFILTER
   * @param {number} channelId
   * @param {object} filter
   * @param {number} filter.type 1=PASS 2=BLOCK 3=FLOW_CONTROL
   * @param {number} [filter.localTxFlags]
   * @param {number} [filter.remoteTxFlags] V2; ISO15765 TX-side flags
   * @param {Buffer|string} filter.mask 5 bytes
   * @param {Buffer|string} filter.pattern 5 bytes (RX ID)
   * @param {number} [filter.exp=0] SPEC/EXCHANGE_EA/OR/XOR…
   * @param {Buffer|string} [filter.argument] same as flowControl (TX id or operand)
   */
  startMsgFilter(channelId, filter) {
    return this._exec(this.codec.encodeStartFilter(channelId, filter), this.codec.decode.startMsgFilter)
  }

  /** 0x0000000A STOPMSGFILTER */
  stopMsgFilter(channelId, filterId) {
    return this._exec(this.codec.encodeStopFilter(channelId, filterId), this.codec.decode.stopMsgFilter)
  }

  /** 0x0000000C READVERSION — returns ErrorCode, Version string */
  async readVersion() {
    const version = await this.device.passThruReadVersion()
    return { error: 0, version }
  }

  /**
   * 0x0000000D IOCTL
   * @param {number} channelId use 0 for device-level (e.g. read voltage)
   * @param {number} ioctlId SET_CONFIG=2, FIVE_BAUD_INIT=4, REQUEST_CONNECTION=0x800A…
   * @param {Buffer} [input]
   */
  ioctl(channelId, ioctlId, input, timeout) {
    return this._exec(
      this.codec.encodeIoctl(channelId || 0, ioctlId, input || Buffer.alloc(0)),
      this.codec.decode.ioctl,
      timeout
    )
  }

  /**
   * 0x0000000E LOGICALCONNECT
   * @param {number} phyChannelId
   * @param {object} opts
   * @param {number} opts.protocolId ISO15765=0x200, TP20=0x300, ISO13400=0x400…
   * @param {number} [opts.connectFlags] add ISO15765_FILTER for filter channels; A-series often MINI
   * @param {number} [opts.localTxFlags] / [opts.remoteTxFlags]
   * @param {Buffer|string} [opts.localAddress] / [opts.remoteAddress] 5 bytes each
   * @param {string} [opts.remoteIP] ETH peer IP (written into LocalTxFlags slot)
   * @param {number} [opts.remotePort] / [opts.localPort] ETH ports
   */
  logicalConnect(phyChannelId, opts = {}) {
    return this._exec(this.codec.encodeLogicalConnect(phyChannelId, {
      protocol: pick(opts, ['protocolId', 'protocol']),
      flags: pick(opts, ['connectFlags', 'flags']),
      localTxFlags: pick(opts, ['localTxFlags']),
      remoteTxFlags: pick(opts, ['remoteTxFlags']),
      localAddress: pick(opts, ['localAddress'], Buffer.alloc(5)),
      remoteAddress: pick(opts, ['remoteAddress'], Buffer.alloc(5)),
      remoteIP: pick(opts, ['remoteIP', 'remoteIp'], undefined),
      remotePort: pick(opts, ['remotePort'], undefined),
      localPort: pick(opts, ['localPort'], undefined)
    }), this.codec.decode.logicalConnect)
  }

  /** 0x0000000F LOGICALDISCONNECT */
  logicalDisconnect(channelId) {
    return this._exec(this.codec.encodeLogicalDisconnect(channelId), this.codec.decode.logicalDisconnect)
  }

  /**
   * 0x00000010 CUSTOM_FEATURE — WiFi 0x15–0x18
   * @param {number} featureId
   * @param {Buffer} [input]
   */
  customFeature(featureId, input, timeout) {
    return this._exec(
      this.codec.encodeCustomFeature(featureId, input || Buffer.alloc(0)),
      this.codec.decode.customFeature,
      timeout
    )
  }

  /** Send an already-encoded command payload; returns raw response (includes ErrorCode). */
  exec(payload, timeout) {
    const c = this.codec
    return this._exec(Buffer.from(payload), (buf) => {
      try {
        const { error } = c.parseResponse(buf)
        return {
          error,
          commandId: payload.length >= 1 ? Buffer.from(payload)[c.isV2 ? 0 : 0] : 0,
          raw: buf
        }
      } catch {
        return {
          error: buf.length >= 4 ? buf.readUInt32LE(0) : 0,
          raw: buf
        }
      }
    }, timeout)
  }
}

module.exports = {
  J2534Protocol,
  Command
}
