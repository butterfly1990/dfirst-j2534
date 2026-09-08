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
 * DFirst J2534 协议接口，和命令字表一一对应。
 * 载荷：LAN 走 RDComm 0x8C；BLE 走 BLEDL，无 RDComm。
 * 编解码走 `device.codec`（按 proVersion V1/V2）。
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

  /** 0x00000001 OPEN — 已打开则直接读版本；按机型自动试 V1/V2 */
  async open() {
    if (this.device.opened) {
      return this.readVersion()
    }
    const version = await this.device.passThruOpen()
    return { error: 0, version }
  }

  /** 0x00000002 CLOSE — 请求无参数；返回 ErrorCode */
  async close() {
    const res = await this._exec(this.codec.encodeClose(), this.codec.decode.close)
    this.device.opened = false
    return res
  }

  /**
   * 0x00000003 CONNECT — 打开物理通道
   * @param {object} opts
   * @param {number} [opts.connectFlags] CAN 常用 CAN_ID_BOTH；ETH 见 DHCP/AUTO_IP
   * @param {number} opts.protocolId Protocol.CAN=5 / ETH=0xFD / ISO9141=3…
   * @param {number} opts.baudRate CAN 500000；K 线 10400
   * @param {number} [opts.pinSelect] 高字节正极低字节负极，OBD CAN=0x060E；0=默认
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
   * @param {number} [opts.msgNum=8] 最多条数
   * @param {number} [opts.timeout=1000] 等待 ms；TIMEOUT/BUFFER_EMPTY 时仍可能有 messages
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
   *   interval=周期 ms；data 写入 12 字节周期槽
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
   * @param {number} [filter.remoteTxFlags] V2；ISO15765 发端标志
   * @param {Buffer|string} filter.mask 5 字节
   * @param {Buffer|string} filter.pattern 5 字节（RX ID）
   * @param {number} [filter.exp=0] SPEC/EXCHANGE_EA/OR/XOR…
   * @param {Buffer|string} [filter.argument] 与 flowControl 同义（TX 或运算数）
   */
  startMsgFilter(channelId, filter) {
    return this._exec(this.codec.encodeStartFilter(channelId, filter), this.codec.decode.startMsgFilter)
  }

  /** 0x0000000A STOPMSGFILTER */
  stopMsgFilter(channelId, filterId) {
    return this._exec(this.codec.encodeStopFilter(channelId, filterId), this.codec.decode.stopMsgFilter)
  }

  /** 0x0000000C READVERSION — 返回 ErrorCode, Version string */
  async readVersion() {
    const version = await this.device.passThruReadVersion()
    return { error: 0, version }
  }

  /**
   * 0x0000000D IOCTL
   * @param {number} channelId 设备级填 0（如读电压）
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
   * @param {number} [opts.connectFlags] 过滤加 ISO15765_FILTER；A 系列常 MINI
   * @param {number} [opts.localTxFlags] / [opts.remoteTxFlags]
   * @param {Buffer|string} [opts.localAddress] / [opts.remoteAddress] 各 5 字节
   * @param {string} [opts.remoteIP] ETH：对端 IP（写入 LocalTxFlags 槽）
   * @param {number} [opts.remotePort] / [opts.localPort] ETH 端口
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
   * 0x00000010 CUSTOM_FEATURE — WiFi 0x15–0x18；升级 0x83–0x89
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

  /** 发送已编码的命令字载荷，返回原始应答（含 ErrorCode）。 */
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

J2534Protocol.Command = Command
J2534Protocol.encode = codec.encode
J2534Protocol.decode = codec.decode
J2534Protocol.createCodec = codec.createCodec

module.exports = { J2534Protocol }
