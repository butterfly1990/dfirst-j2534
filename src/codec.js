'use strict'

const { Command, ErrorName, WifiStateName, Ioctl, ConnectFlag, TxFlag } = require('./constants')
const { DFirstJ2534Error } = require('./errors')
const { normalizeProVersion } = require('./proVersion')

/**
 * SDK API 统一用 V2 位图；V1 线上 ConnectFlags / TxFlags 只有 1 字节且位定义不同。
 * 例：V2 RemoteTx PAD=0x800040 → 低字节 0x40，在 V1 被当成 CAN_FD_FORMAT → FLAG_NOT_SUPPORTED。
 */
function mapConnectFlagsV1(flags) {
  const f = flags >>> 0
  let out = 0
  if (f & ConnectFlag.FULL_DUPLEX) out |= 0x01
  if (f & ConnectFlag.CAN_29BIT_ID) out |= 0x02
  if (f & ConnectFlag.CHECKSUM_DISABLE) out |= 0x04
  if (f & ConnectFlag.CAN_ID_BOTH) out |= 0x08
  if (f & ConnectFlag.K_LINE_ONLY) out |= 0x10
  if (f & ConnectFlag.ISO15765_MINI) out |= 0x20
  if (f & ConnectFlag.ETH_TCP) out |= 0x40
  // ISO15765_FILTER(V2 0x40000000) 在 V1 不是 ConnectFlags 位，而是 ProtocolID=0x201
  if (out === 0 && f !== 0 && f <= 0xff) return f & 0xff
  return out & 0xff
}

function mapTxFlagsV1(flags) {
  const f = flags >>> 0
  let out = 0
  if (f & TxFlag.ISO15765_FRAME_PAD) out |= 0x01
  if (f & TxFlag.ISO15765_ADDR_TYPE) out |= 0x02
  if (f & TxFlag.CAN_29BIT_ID) out |= 0x04
  if (f & TxFlag.CANFD_FORMAT) out |= 0x40
  if (f & TxFlag.CANFD_BRS) out |= 0x80
  if (out === 0 && f !== 0 && f <= 0xff) return f & 0xff
  return out & 0xff
}

/** V1 固件用 1 字节 IOCTL ID；V2 用扩展 ID（0x1000x / 0x800x）。 */
const IoctlIdV1 = {
  [Ioctl.ETH_GET_OPTION]: 0x12,
  [Ioctl.ETH_BMW_DISCOVERY]: 0x13,
  [Ioctl.ETH_GET_DHCP_POOL]: 0x14,
  [Ioctl.ISO13400_DISCOVERY]: 0x15,
  [Ioctl.ISO13400_ROUTING_ACTIVE]: 0x16,
  [Ioctl.CLEAR_ALL_RX_QUEUE]: 0x17,
  [Ioctl.REQUEST_CONNECTION]: 0x10,
  [Ioctl.TEARDOWN_CONNECTION]: 0x11
}

/** V2 SET_CONFIG Index → V1 1 字节 Index（Activer `_initValue('ioctrl', v2, v1)`）。 */
const ConfigParamV1 = {
  [0x805C]: 0x02, // CAN_FD_DATA_PHASE_RATE → CAN_CFG_FD_DATA_RATE
  [0x805D]: 0x31, // FD_ISO15765_TX_DATA_LENGTH（与 ECHO 同号，仅 FD/15765 通道）
  // 0x805E CAN_HS_TERMINATION：V1 无对应 Index，走 ConnectFlags 也不支持
  // TP20 V2 扩展 timing → V1 VW_TP20_CFG_*
  [0x8045]: 0x02, // T_E
  [0x8046]: 0x03, // MNTC
  [0x804C]: 0x09, // T1
  [0x804D]: 0x0A  // T3
}

function mapConfigParamV1(paramId) {
  const id = paramId >>> 0
  if (ConfigParamV1[id] != null) return ConfigParamV1[id] & 0xff
  return id & 0xff
}

function u32(value) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(value >>> 0, 0)
  return buf
}

function toBuf(input, size) {
  if (Buffer.isBuffer(input)) {
    if (size && input.length !== size) {
      const out = Buffer.alloc(size)
      input.copy(out, 0, 0, Math.min(size, input.length))
      return out
    }
    return Buffer.from(input)
  }
  if (Array.isArray(input)) {
    return toBuf(Buffer.from(input), size)
  }
  if (typeof input === 'string') {
    const hex = input.replace(/[\s,]/g, '')
    return toBuf(Buffer.from(hex, 'hex'), size)
  }
  if (typeof input === 'number' && size) {
    const out = Buffer.alloc(size)
    if (size <= 4) {
      out.writeUIntBE(input >>> 0, size === 5 ? 1 : 0, Math.min(4, size))
      if (size === 5) {
        out.writeUInt32BE(input >>> 0, 0)
        out[4] = 0
      }
    }
    return out
  }
  throw new DFirstJ2534Error('expected Buffer, hex string, array or number')
}

/** 4-byte big-endian CAN ID used in ISO15765 payloads. */
function canId4(id) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(id >>> 0, 0)
  return buf
}

/** 5-byte ID used in ISO15765 filters (CAN ID + extra address). */
function canId5(id, extra = 0) {
  const buf = Buffer.alloc(5)
  buf.writeUInt32BE(id >>> 0, 0)
  buf[4] = extra & 0xff
  return buf
}

/**
 * LOGICALCONNECT / filter address: 5 bytes.
 * 1–8 hex digits = CAN ID (extra byte 0 unless `extra` given); 10 hex = full 5 bytes.
 */
function addr5(input, extra = 0) {
  if (input == null || input === '') {
    return canId5(0, extra)
  }
  if (typeof input === 'number') {
    return canId5(input, extra)
  }
  if (Buffer.isBuffer(input) || Array.isArray(input)) {
    return toBuf(input, 5)
  }
  const hex = String(input).replace(/[\s,]/g, '')
  if (!hex) {
    return canId5(0, extra)
  }
  if (hex.length <= 8) {
    return canId5(parseInt(hex, 16) || 0, extra)
  }
  return toBuf(hex.padStart(10, '0').slice(-10), 5)
}

/** IPv4 → u32 overlay (byte0=a of a.b.c.d, LE on wire for V2). */
function ip4u32(input) {
  if (input == null || input === '') return 0
  if (typeof input === 'number') return input >>> 0
  if (Buffer.isBuffer(input)) {
    return input.length >= 4 ? input.readUInt32LE(0) : 0
  }
  const s = String(input).trim()
  if (!s) return 0
  if (/^\d+$/.test(s) || /^0x/i.test(s)) return Number(s) >>> 0
  const p = s.split('.')
  if (p.length !== 4) {
    throw new DFirstJ2534Error('expected IPv4 a.b.c.d')
  }
  const oct = p.map((x) => Number(x))
  if (oct.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new DFirstJ2534Error('expected IPv4 a.b.c.d')
  }
  return (oct[0] | (oct[1] << 8) | (oct[2] << 16) | (oct[3] << 24)) >>> 0
}

function ip4buf(input) {
  if (Buffer.isBuffer(input) && input.length >= 4) return Buffer.from(input.slice(0, 4))
  const u = ip4u32(input)
  return Buffer.from([u & 0xff, (u >>> 8) & 0xff, (u >>> 16) & 0xff, (u >>> 24) & 0xff])
}

function ipv4String(buf, offset = 0) {
  if (!buf || buf.length < offset + 4) return ''
  return `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`
}

function isLinkLocalIp(buf, offset = 0) {
  return !!(buf && buf.length >= offset + 2 && buf[offset] === 0xA9 && buf[offset + 1] === 0xFE)
}

/** ETH_BMW 发现 Desc：DIAGADR10BMWMAC<12hex>BMWVIN<vin> */
function parseBmwDesc(desc) {
  const raw = String(desc || '').replace(/\0+$/g, '')
  const parts = raw.split('BMW')
  let diagadr = ''
  let mac = ''
  let vin = ''
  if (parts.length >= 3) {
    diagadr = parts[0].replace(/^DIAGADR/i, '')
    mac = parts[1].replace(/^MAC/i, '')
    vin = parts[2].replace(/^VIN/i, '')
  }
  vin = vin.replace(/[\x00-\x1f\x7f-\xff]/g, '').trim()
  return { desc: raw, diagadr, mac, vin }
}

/**
 * ISO13400_ROUTING_ACTIVE。对齐 Activer：SourceAddr BE u16 + ActivationType u8 + Version u8（共 4 字节）。
 */
function encodeDoipRoutingActivation({ sourceAddr = 0x0E80, activationType = 0, version = 0x02 } = {}) {
  const buf = Buffer.alloc(4)
  buf.writeUInt16BE(sourceAddr & 0xffff, 0)
  buf[2] = activationType & 0xff
  buf[3] = version & 0xff
  return buf
}

function encodeWifiSsidPw(ssid, password = '') {
  return Buffer.concat([
    Buffer.from(String(ssid || ''), 'utf8'),
    Buffer.from([0]),
    Buffer.from(String(password || ''), 'utf8'),
    Buffer.from([0])
  ])
}

function encodeEraseType(type) {
  return u32(type)
}

function encodeEraseFlash(addr, pageNum) {
  return Buffer.concat([u32(addr), u32(pageNum)])
}

function encodeProgramFlash(addr, data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data)
  return Buffer.concat([u32(addr), payload])
}

function parseFlashInfo(buf) {
  const raw = Buffer.isBuffer(buf) ? buf : Buffer.alloc(0)
  if (raw.length < 16) {
    return { startAddr: 0, endAddr: 0, pageNum: 0, pageSize: 0 }
  }
  return {
    startAddr: raw.readUInt32LE(0),
    endAddr: raw.readUInt32LE(4),
    pageNum: raw.readUInt32LE(8),
    pageSize: raw.readUInt32LE(12)
  }
}

function parseWifiState(buf) {
  const raw = Buffer.isBuffer(buf) ? buf.toString('utf8').replace(/\0+$/, '').trim() : String(buf || '')
  const m = raw.match(/^(\d+)\s*,\s*"?([^"]*)"?/)
  const state = m ? Number(m[1]) : null
  return {
    raw,
    state,
    ssid: m ? m[2] : '',
    label: state != null && WifiStateName[state] != null ? WifiStateName[state] : '未知'
  }
}

/** SCAN_WIFI 输出：`len,ssid,ecn,rssi;` 重复 */
function parseWifiScan(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '')
  const list = []
  let i = 0
  while (i < text.length) {
    const comma = text.indexOf(',', i)
    if (comma < 0) {
      break
    }
    const len = Number(text.slice(i, comma))
    if (!Number.isFinite(len) || len < 0) {
      break
    }
    const ssidStart = comma + 1
    const ssid = text.slice(ssidStart, ssidStart + len)
    let p = ssidStart + len
    if (text[p] === ',') {
      p += 1
    }
    const semi = text.indexOf(';', p)
    if (semi < 0) {
      break
    }
    const parts = text.slice(p, semi).split(',')
    const ecn = Number(parts[0])
    const rssi = Number(parts[1])
    if (ssid) {
      list.push({ ssid, ecn, rssi })
    }
    i = semi + 1
  }
  return list
}

function throwIfError(error, allow = []) {
  if (error && !allow.includes(error)) {
    const name = ErrorName[error] || 'UNKNOWN'
    throw new DFirstJ2534Error(`J2534 ${name} (0x${error.toString(16)})`, {
      code: error,
      source: 'j2534'
    })
  }
}

/**
 * @param {'V1'|'V2'|string} [proVersion]
 */
function createCodec(proVersion = 'V2') {
  const isV2 = normalizeProVersion(proVersion) !== 'V1'
  const ver = isV2 ? 'V2' : 'V1'

  function uN(value, n) {
    const buf = Buffer.alloc(n)
    if (n === 1) {
      buf[0] = value & 0xff
      return buf
    }
    if (isV2) {
      buf.writeUIntLE(value >>> 0, 0, n)
    } else {
      buf.writeUIntBE(value >>> 0, 0, n)
    }
    return buf
  }

  function cmd(id, width) {
    return uN(id & 0xff, width != null ? width : (isV2 ? 4 : 1))
  }

  function mapIoctlId(ioctlId) {
    const id = ioctlId >>> 0
    if (isV2) return id
    if (IoctlIdV1[id] != null) return IoctlIdV1[id]
    return id & 0xff
  }

  function wireConnectFlags(flags) {
    return isV2 ? (flags >>> 0) : mapConnectFlagsV1(flags)
  }

  function wireTxFlags(flags) {
    return isV2 ? (flags >>> 0) : mapTxFlagsV1(flags)
  }

  function wireConfigParam(paramId) {
    return isV2 ? (paramId >>> 0) : mapConfigParamV1(paramId)
  }

  /** SET_CONFIG / FUNCT_LOOKUP：Input 自带 Num，不再外包 InputLength。 */
  function ioctlInputSelfSized(ioctlId) {
    const id = mapIoctlId(ioctlId)
    return id === Ioctl.SET_CONFIG ||
      id === Ioctl.GET_CONFIG ||
      id === Ioctl.ADD_TO_FUNCT_MSG_LOOKUP_TABLE ||
      id === Ioctl.DELETE_FROM_FUNCT_MSG_LOOKUP_TABLE
  }

  function encodeOpen() {
    return cmd(Command.OPEN)
  }

  function encodeClose() {
    // V2：历史载荷仅 Command u32（固件不要求 DeviceId）。V1：cmd + DeviceId(0)。
    return isV2
      ? cmd(Command.CLOSE)
      : Buffer.concat([cmd(Command.CLOSE), Buffer.from([0])])
  }

  function encodeReadVersion() {
    return cmd(Command.READ_VERSION)
  }

  function encodeConnect({ protocol, baud, flags = 0, pinSelect = 0 } = {}) {
    const cof = wireConnectFlags(flags)
    if (isV2) {
      return Buffer.concat([
        cmd(Command.CONNECT),
        uN(cof, 4),
        uN(protocol, 4),
        uN(baud, 4),
        uN(pinSelect, 4)
      ])
    }
    // V1: cmd1 + flags1 + protocol2 + baud4；无 PinSelect
    return Buffer.concat([
      cmd(Command.CONNECT),
      uN(cof, 1),
      uN(protocol, 2),
      uN(baud, 4)
    ])
  }

  function encodeDisconnect(channelId) {
    return Buffer.concat([cmd(Command.DISCONNECT), uN(channelId, isV2 ? 4 : 1)])
  }

  function encodeLogicalConnect(phyChannel, {
    protocol,
    flags = 0,
    localTxFlags = 0,
    remoteTxFlags = 0,
    localAddress = Buffer.alloc(5),
    remoteAddress = Buffer.alloc(5),
    remoteIP,
    remotePort,
    localPort,
    version = 0
  } = {}) {
    const eth = remoteIP !== undefined || remotePort !== undefined || localPort !== undefined
    if (eth) {
      if (isV2) {
        localTxFlags = ip4u32(remoteIP)
        remoteTxFlags = (remotePort != null ? Number(remotePort) : 0) >>> 0
        const loc = Buffer.alloc(5)
        loc.writeUInt32LE((localPort != null ? Number(localPort) : 0) >>> 0, 0)
        loc[4] = version & 0xff
        localAddress = loc
        remoteAddress = Buffer.alloc(5)
      } else {
        // V1 ETH：IP4 + dstPort2 + srcPort2（无 5+5 地址尾）
        return Buffer.concat([
          cmd(Command.LOGICAL_CONNECT),
          uN(phyChannel, 1),
          uN(protocol, 2),
          uN(wireConnectFlags(flags), 1),
          ip4buf(remoteIP),
          uN(remotePort != null ? Number(remotePort) : 0, 2),
          uN(localPort != null ? Number(localPort) : 0, 2)
        ])
      }
    }
    if (isV2) {
      return Buffer.concat([
        cmd(Command.LOGICAL_CONNECT),
        uN(phyChannel, 4),
        uN(protocol, 4),
        uN(wireConnectFlags(flags), 4),
        uN(wireTxFlags(localTxFlags), 4),
        uN(wireTxFlags(remoteTxFlags), 4),
        toBuf(localAddress, 5),
        toBuf(remoteAddress, 5)
      ])
    }
    return Buffer.concat([
      cmd(Command.LOGICAL_CONNECT),
      uN(phyChannel, 1),
      uN(protocol, 2),
      uN(wireConnectFlags(flags), 1),
      uN(wireTxFlags(localTxFlags), 1),
      uN(wireTxFlags(remoteTxFlags), 1),
      toBuf(localAddress, 5),
      toBuf(remoteAddress, 5)
    ])
  }

  function encodeLogicalDisconnect(channelId) {
    return Buffer.concat([cmd(Command.LOGICAL_DISCONNECT), uN(channelId, isV2 ? 4 : 1)])
  }

  function encodeWrite(channelId, msgs) {
    const list = Array.isArray(msgs) ? msgs : [msgs]
    const bodies = list.map((msg) => {
      const data = toBuf(msg.data)
      if (isV2) {
        return Buffer.concat([
          uN(msg.handle || 0, 4),
          uN(wireTxFlags(msg.txFlags || 0), 4),
          uN(data.length, 4),
          data
        ])
      }
      return Buffer.concat([
        uN(msg.handle || 0, 4),
        uN(wireTxFlags(msg.txFlags || 0), 1),
        uN(data.length, 2),
        data
      ])
    })
    return Buffer.concat([
      cmd(Command.WRITE_MSG),
      uN(channelId, isV2 ? 4 : 1),
      uN(list.length, isV2 ? 4 : 1),
      ...bodies
    ])
  }

  function encodeRead(channelId, { num = 8, timeout = 1000 } = {}) {
    if (isV2) {
      return Buffer.concat([
        cmd(Command.READ_MSG),
        uN(channelId, 4),
        uN(num, 4),
        uN(timeout, 4)
      ])
    }
    return Buffer.concat([
      cmd(Command.READ_MSG),
      uN(channelId, 1),
      uN(num, 1),
      uN(timeout, 2)
    ])
  }

  function encodeStartFilter(channelId, {
    type,
    localTxFlags = 0,
    remoteTxFlags = 0,
    mask,
    pattern,
    flowControl,
    exp = 0,
    argument
  } = {}) {
    const arg = argument != null ? argument : flowControl
    if (isV2) {
      return Buffer.concat([
        cmd(Command.START_MSG_FILTER),
        uN(channelId, 4),
        uN(type, 4),
        uN(wireTxFlags(localTxFlags), 4),
        uN(wireTxFlags(remoteTxFlags), 4),
        toBuf(mask, 5),
        toBuf(pattern, 5),
        Buffer.from([exp & 0xff]),
        toBuf(arg || Buffer.alloc(5), 5)
      ])
    }
    // V1 无 remoteTxFlags
    return Buffer.concat([
      cmd(Command.START_MSG_FILTER),
      uN(channelId, 1),
      uN(type, 1),
      uN(wireTxFlags(localTxFlags), 1),
      toBuf(mask, 5),
      toBuf(pattern, 5),
      Buffer.from([exp & 0xff]),
      toBuf(arg || Buffer.alloc(5), 5)
    ])
  }

  function encodeStopFilter(channelId, filterId) {
    return Buffer.concat([
      cmd(Command.STOP_MSG_FILTER),
      uN(channelId, isV2 ? 4 : 1),
      uN(filterId, isV2 ? 4 : 1)
    ])
  }

  function encodeStartPeriodic(channelId, {
    interval,
    handle = 0,
    data,
    txFlags = 0
  } = {}) {
    const payload = toBuf(data)
    const period = Buffer.alloc(12)
    payload.copy(period, 0, 0, Math.min(12, payload.length))
    if (isV2) {
      return Buffer.concat([
        cmd(Command.START_PERIODIC_MSG),
        uN(channelId, 4),
        uN(interval, 4),
        uN(handle, 4),
        uN(payload.length, 4),
        uN(wireTxFlags(txFlags), 4),
        period
      ])
    }
    return Buffer.concat([
      cmd(Command.START_PERIODIC_MSG),
      uN(channelId, 1),
      uN(interval, 2),
      uN(handle, 4),
      uN(payload.length, 2),
      uN(wireTxFlags(txFlags), 1),
      period
    ])
  }

  function encodeStopPeriodic(channelId, msgId) {
    return Buffer.concat([
      cmd(Command.STOP_PERIODIC_MSG),
      uN(channelId, isV2 ? 4 : 1),
      uN(msgId, isV2 ? 4 : 1)
    ])
  }

  function encodeIoctl(channelId, ioctlId, input = Buffer.alloc(0)) {
    const data = toBuf(input)
    const id = mapIoctlId(ioctlId)
    if (isV2) {
      return Buffer.concat([
        cmd(Command.IOCTL),
        uN(channelId, 4),
        uN(id, 4),
        uN(data.length, 4),
        data
      ])
    }
    // V1：cmd1 + ch1 + id1 + len2 + input（与小程序 ioctrl 一致；CLEAR 也带 len=0）
    // SET_CONFIG / GET_CONFIG / FUNCT_LOOKUP：Activer 把 Num 放在 len 槽，input 已自带 Num。
    const parts = [
      cmd(Command.IOCTL),
      uN(channelId, 1),
      uN(id, 1)
    ]
    if (ioctlInputSelfSized(ioctlId)) {
      if (data.length) parts.push(data)
    } else {
      parts.push(uN(data.length, 2))
      if (data.length) parts.push(data)
    }
    return Buffer.concat(parts)
  }

  /** ETH_BMW_DISCOVERY / ISO13400_DISCOVERY Input */
  function encodeEthDiscovery({ num = 10, timeout = 3000, version } = {}) {
    if (isV2) {
      if (version == null) {
        const buf = Buffer.alloc(8)
        buf.writeUInt32LE(num >>> 0, 0)
        buf.writeUInt32LE(timeout >>> 0, 4)
        return buf
      }
      const buf = Buffer.alloc(9)
      buf.writeUInt32LE(num >>> 0, 0)
      buf.writeUInt32LE(timeout >>> 0, 4)
      buf[8] = version & 0xff
      return buf
    }
    // V1：Num1 + Timeout2 [+ Version1]
    if (version == null) {
      return Buffer.concat([uN(num, 1), uN(timeout, 2)])
    }
    return Buffer.concat([uN(num, 1), uN(timeout, 2), Buffer.from([version & 0xff])])
  }

  function encodeCustomFeature(featureId, input = Buffer.alloc(0), channelId = 0) {
    const data = Buffer.isBuffer(input) ? input : toBuf(input)
    if (isV2) {
      return Buffer.concat([
        cmd(Command.CUSTOM_FEATURE),
        uN(channelId, 4),
        uN(featureId, 4),
        uN(data.length, 4),
        data
      ])
    }
    return Buffer.concat([
      cmd(Command.CUSTOM_FEATURE),
      uN(channelId, 1),
      uN(featureId, 1),
      uN(data.length, 2),
      data
    ])
  }

  /** SET_CONFIG Input：Num + {Index, Value}[]；GET_CONFIG：Num + Index[] */
  function encodeSetConfig(items) {
    const list = Array.isArray(items) ? items : [items]
    if (isV2) {
      const parts = [uN(list.length, 4)]
      for (const it of list) {
        const id = it.paramId != null ? it.paramId : it.index
        parts.push(uN(id, 4), uN(it.value, 4))
      }
      return Buffer.concat(parts)
    }
    // V1：Num(2) + index1 + value4
    const parts = [uN(list.length, 2)]
    for (const it of list) {
      const id = it.paramId != null ? it.paramId : it.index
      parts.push(Buffer.from([wireConfigParam(id) & 0xff]), uN(it.value, 4))
    }
    return Buffer.concat(parts)
  }

  /** GET_CONFIG Input：仅 Index 列表 */
  function encodeGetConfig(items) {
    const list = Array.isArray(items) ? items : [items]
    if (isV2) {
      const parts = [uN(list.length, 4)]
      for (const it of list) {
        const id = typeof it === 'object' ? (it.paramId != null ? it.paramId : it.index) : it
        parts.push(uN(id, 4))
      }
      return Buffer.concat(parts)
    }
    const parts = [uN(list.length, 2)]
    for (const it of list) {
      const id = typeof it === 'object' ? (it.paramId != null ? it.paramId : it.index) : it
      parts.push(Buffer.from([wireConfigParam(id) & 0xff]))
    }
    return Buffer.concat(parts)
  }

  /** ADD/DELETE_FUNCT_MSG_LOOKUP_TABLE */
  function encodeFunctLookup(addrs) {
    const list = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => a & 0xff)
    if (isV2) {
      const buf = Buffer.alloc(4 + list.length)
      buf.writeUInt32LE(list.length, 0)
      for (let i = 0; i < list.length; i++) {
        buf[4 + i] = list[i]
      }
      return buf
    }
    const buf = Buffer.alloc(2 + list.length)
    buf.writeUInt16BE(list.length, 0)
    for (let i = 0; i < list.length; i++) {
      buf[2 + i] = list[i]
    }
    return buf
  }

  function encodeTp20RequestConnection({
    identifier = 0x200,
    destination = 0x01,
    opcode = 0xC0,
    txIdA = 0x1000,
    rxIdA = 0x300,
    app = 0x01,
    t1 = 0,
    t3 = 0
  } = {}) {
    if (isV2) {
      const buf = Buffer.alloc(11)
      buf.writeUInt32LE(identifier >>> 0, 0)
      buf.writeUInt8(destination & 0xff, 4)
      buf.writeUInt8(opcode & 0xff, 5)
      buf.writeUInt16LE(txIdA & 0xffff, 6)
      buf.writeUInt16LE(rxIdA & 0xffff, 8)
      buf.writeUInt8(app & 0xff, 10)
      return buf
    }
    // V1 IOC_TP20_CONNECT_ECU：Dest1 + SetupRequestID2 BE + LocalT1 + LocalT3
    const buf = Buffer.alloc(5)
    buf[0] = destination & 0xff
    buf.writeUInt16BE((identifier || 0x200) & 0xffff, 1)
    buf[3] = t1 & 0xff
    buf[4] = t3 & 0xff
    return buf
  }

  function encodeTp16RequestConnection({
    identifier = 0x200,
    destination = 0x01,
    opcode = 0xC0,
    chId = 0x01
  } = {}) {
    if (!isV2) {
      // V1 固件无 TP16 / REQUEST_CONNECTION(0x800A) 扩展载荷
      throw new DFirstJ2534Error('TP16 REQUEST_CONNECTION is V2-only', { source: 'j2534' })
    }
    const buf = Buffer.alloc(7)
    buf.writeUInt32LE(identifier >>> 0, 0)
    buf.writeUInt8(destination & 0xff, 4)
    buf.writeUInt8(opcode & 0xff, 5)
    buf.writeUInt8(chId & 0xff, 6)
    return buf
  }

  function readU(buf, offset, n) {
    if (!buf || offset + n > buf.length) return 0
    if (n === 1) return buf[offset]
    return isV2 ? buf.readUIntLE(offset, n) : buf.readUIntBE(offset, n)
  }

  /**
   * V2：应答从 ErrorCode u32 起。
   * V1：首字节为命令回显 (cmd|0x80)，随后 1 字节 ErrorCode。
   */
  function parseResponse(buf) {
    if (!buf || buf.length < (isV2 ? 4 : 2)) {
      throw new DFirstJ2534Error('J2534 response too short', { source: 'j2534' })
    }
    if (isV2) {
      const error = buf.readUInt32LE(0)
      return { error, rest: buf.slice(4), raw: buf, echo: null }
    }
    const echo = buf[0]
    const error = buf[1]
    return { error, rest: buf.slice(2), raw: buf, echo }
  }

  function parseError(buf) {
    const { error } = parseResponse(buf)
    throwIfError(error)
    return { error }
  }

  function parseOpen(buf) {
    const { error, rest } = parseResponse(buf)
    throwIfError(error)
    return {
      error,
      version: rest.toString('ascii').replace(/\0+$/, '').trim()
    }
  }

  function parseWrite(buf) {
    const { error, rest } = parseResponse(buf)
    throwIfError(error)
    const w = isV2 ? 4 : 1
    return {
      error,
      channelId: rest.length >= w ? readU(rest, 0, w) : 0,
      msgNum: rest.length >= w * 2 ? readU(rest, w, w) : 0
    }
  }

  function parseChannel(buf) {
    const { error, rest } = parseResponse(buf)
    throwIfError(error)
    const w = isV2 ? 4 : 1
    return {
      error,
      channelId: rest.length >= w ? readU(rest, 0, w) : 0
    }
  }

  function parseLogicalConnect(buf) {
    const { error, rest } = parseResponse(buf)
    throwIfError(error)
    const w = isV2 ? 4 : 1
    return {
      error,
      phyChannelId: rest.length >= w ? readU(rest, 0, w) : 0,
      channelId: rest.length >= w * 2 ? readU(rest, w, w) : 0
    }
  }

  function parseId(buf) {
    const { error, rest } = parseResponse(buf)
    throwIfError(error)
    const w = isV2 ? 4 : 1
    const channelId = rest.length >= w ? readU(rest, 0, w) : 0
    const id = rest.length >= w * 2 ? readU(rest, w, w) : 0
    return { error, channelId, id }
  }

  function parseRead(buf) {
    const { error, rest } = parseResponse(buf)
    throwIfError(error, [0x09, 0x10])
    const w = isV2 ? 4 : 1
    if (rest.length < w * 2) {
      return { error, channelId: 0, msgNum: 0, messages: [] }
    }
    const channelId = readU(rest, 0, w)
    const msgNum = readU(rest, w, w)
    const messages = []
    let offset = w * 2
    const hdr = isV2 ? 16 : 10
    while (offset + hdr <= rest.length) {
      let timestamp
      let rxStatus
      let dataSize
      let extraDataIndex
      if (isV2) {
        timestamp = rest.readUInt32LE(offset)
        rxStatus = rest.readUInt32LE(offset + 4)
        dataSize = rest.readUInt32LE(offset + 8)
        extraDataIndex = rest.readUInt32LE(offset + 12)
      } else {
        timestamp = rest.readUInt32BE(offset)
        rxStatus = rest.readUInt16BE(offset + 4)
        dataSize = rest.readUInt16BE(offset + 6)
        extraDataIndex = rest.readUInt16BE(offset + 8)
      }
      offset += hdr
      if (offset + dataSize > rest.length) {
        break
      }
      const data = Buffer.from(rest.slice(offset, offset + dataSize))
      offset += dataSize
      messages.push({ timestamp, rxStatus, dataSize, extraDataIndex, data })
    }
    return { error, channelId, msgNum, messages }
  }

  function parseIoctl(buf) {
    const { error, rest } = parseResponse(buf)
    throwIfError(error)
    const lenW = isV2 ? 4 : 2
    if (rest.length < lenW) {
      return { error, output: Buffer.alloc(0), outputLength: 0 }
    }
    const outputLength = readU(rest, 0, lenW)
    return {
      error,
      outputLength,
      output: Buffer.from(rest.slice(lenW, lenW + outputLength))
    }
  }

  /** V2：MsgNum u32 + { IP[4], DescLength u32, Desc[] }*；V1 无 MsgNum，DescLength u16 */
  function parseBmwDiscovery(output) {
    if (!output || !output.length) return []
    let offset = 0
    if (isV2) {
      if (output.length < 4) return []
      const num = output.readUInt32LE(0)
      offset = 4
      const list = []
      for (let i = 0; i < num && offset + 8 <= output.length; i++) {
        const ip = output.slice(offset, offset + 4)
        const descLen = output.readUInt32LE(offset + 4)
        offset += 8
        const descBuf = output.slice(offset, Math.min(output.length, offset + descLen))
        offset += descLen
        const desc = descBuf.toString('ascii').replace(/\0+$/g, '')
        const parsed = parseBmwDesc(desc)
        list.push({
          ip: ipv4String(ip),
          ipU32: ip.readUInt32LE(0),
          desc,
          diagadr: parsed.diagadr,
          mac: parsed.mac,
          vin: parsed.vin,
          diagadr10: desc.indexOf('DIAGADR10') === 0 || parsed.diagadr === '10',
          linkLocal: isLinkLocalIp(ip)
        })
      }
      return list
    }
    const list = []
    while (offset + 6 <= output.length) {
      const ip = output.slice(offset, offset + 4)
      const descLen = output.readUInt16BE(offset + 4)
      offset += 6
      const descBuf = output.slice(offset, Math.min(output.length, offset + descLen))
      offset += descLen
      const desc = descBuf.toString('ascii').replace(/\0+$/g, '')
      const parsed = parseBmwDesc(desc)
      list.push({
        ip: ipv4String(ip),
        ipU32: ip.readUInt32LE(0),
        desc,
        diagadr: parsed.diagadr,
        mac: parsed.mac,
        vin: parsed.vin,
        diagadr10: desc.indexOf('DIAGADR10') === 0 || parsed.diagadr === '10',
        linkLocal: isLinkLocalIp(ip)
      })
    }
    return list
  }

  /** V2：40 字节对齐；V1：37 字节记录 */
  function parseIso13400Discovery(output) {
    if (!output || output.length < 4) return []
    const block = isV2 ? 40 : 37
    let offset = 0
    let maybeNum = 0
    if (isV2) {
      maybeNum = output.readUInt32LE(0)
      offset = (maybeNum >= 1 && maybeNum <= 32) ? 4 : 0
    }
    const list = []
    while (offset + 4 <= output.length) {
      const rec = output.slice(offset, Math.min(output.length, offset + block))
      const ip = rec.slice(0, 4)
      list.push({
        ip: ipv4String(ip),
        ipU32: ip.readUInt32LE(0),
        version: rec.length > 4 ? rec[4] : 0,
        vin: rec.length >= 22 ? rec.slice(5, 22).toString('ascii').replace(/[\x00-\x1f\x7f-\xff]/g, '').trim() : '',
        vinHex: rec.length >= 22 ? rec.slice(5, 22).toString('hex') : rec.slice(Math.min(5, rec.length)).toString('hex'),
        logicAddr: rec.length >= 24 ? rec.readUInt16BE(22) : 0,
        eid: rec.length >= 30 ? rec.slice(24, 30).toString('hex') : '',
        gid: rec.length >= 36 ? rec.slice(30, 36).toString('hex') : '',
        far: rec.length > 36 ? rec[36] : 0,
        linkLocal: isLinkLocalIp(ip)
      })
      offset += block
      if (isV2 && maybeNum >= 1 && maybeNum <= 32 && list.length >= maybeNum) {
        break
      }
    }
    return list
  }

  function parseOutEvent(buf) {
    if (!buf || buf.length < 24) {
      return []
    }
    const queueNum = buf.readUInt8(0)
    const messages = []
    let offset = 4
    let n = 0
    while (offset + 20 <= buf.length && n < Math.max(queueNum, 1)) {
      const channelId = buf.readUInt32LE(offset)
      const timestamp = buf.readUInt32LE(offset + 4)
      const rxStatus = buf.readUInt32LE(offset + 8)
      const dataSize = buf.readUInt32LE(offset + 12)
      const extraDataIndex = buf.readUInt32LE(offset + 16)
      offset += 20
      if (offset + dataSize > buf.length) {
        break
      }
      const data = Buffer.from(buf.slice(offset, offset + dataSize))
      offset += (dataSize + 3) & ~3
      n++
      messages.push({ channelId, timestamp, rxStatus, dataSize, extraDataIndex, data })
    }
    return messages
  }

  const encode = {
    open: encodeOpen,
    close: encodeClose,
    connect: encodeConnect,
    disconnect: encodeDisconnect,
    readMsg: encodeRead,
    writeMsg: encodeWrite,
    startPeriodicMsg: encodeStartPeriodic,
    stopPeriodicMsg: encodeStopPeriodic,
    startMsgFilter: encodeStartFilter,
    stopMsgFilter: encodeStopFilter,
    readVersion: encodeReadVersion,
    ioctl: encodeIoctl,
    ethDiscovery: encodeEthDiscovery,
    doipRoutingActivation: encodeDoipRoutingActivation,
    setConfig: encodeSetConfig,
    getConfig: encodeGetConfig,
    functLookup: encodeFunctLookup,
    tp20RequestConnection: encodeTp20RequestConnection,
    tp16RequestConnection: encodeTp16RequestConnection,
    customFeature: encodeCustomFeature,
    wifiSsidPw: encodeWifiSsidPw,
    eraseType: encodeEraseType,
    eraseFlash: encodeEraseFlash,
    programFlash: encodeProgramFlash,
    logicalConnect: encodeLogicalConnect,
    logicalDisconnect: encodeLogicalDisconnect
  }

  const decode = {
    open: parseOpen,
    close: parseError,
    connect: parseChannel,
    disconnect: parseChannel,
    readMsg: parseRead,
    writeMsg: parseWrite,
    startPeriodicMsg: parseId,
    stopPeriodicMsg: parseChannel,
    startMsgFilter: parseId,
    stopMsgFilter: parseChannel,
    readVersion: parseOpen,
    ioctl: parseIoctl,
    bmwDiscovery: parseBmwDiscovery,
    iso13400Discovery: parseIso13400Discovery,
    customFeature: parseIoctl,
    logicalConnect: parseLogicalConnect,
    logicalDisconnect: parseChannel
  }

  return {
    proVersion: ver,
    isV2,
    encode,
    decode,
    encodeOpen,
    encodeClose,
    encodeReadVersion,
    encodeConnect,
    encodeDisconnect,
    encodeLogicalConnect,
    encodeLogicalDisconnect,
    encodeWrite,
    encodeRead,
    encodeStartFilter,
    encodeStopFilter,
    encodeStartPeriodic,
    encodeStopPeriodic,
    encodeIoctl,
    encodeEthDiscovery,
    encodeDoipRoutingActivation,
    encodeSetConfig,
    encodeGetConfig,
    encodeFunctLookup,
    encodeTp20RequestConnection,
    encodeTp16RequestConnection,
    encodeCustomFeature,
    encodeWifiSsidPw,
    encodeEraseType,
    encodeEraseFlash,
    encodeProgramFlash,
    parseBmwDiscovery,
    parseIso13400Discovery,
    parseResponse,
    parseError,
    parseOpen,
    parseChannel,
    parseLogicalConnect,
    parseId,
    parseRead,
    parseWrite,
    parseIoctl,
    parseOutEvent,
    throwIfError,
    mapIoctlId
  }
}

const defaultCodec = createCodec('V2')

module.exports = {
  u32,
  toBuf,
  canId4,
  canId5,
  addr5,
  ip4u32,
  createCodec,
  IoctlIdV1,
  ConfigParamV1,
  mapConnectFlagsV1,
  mapTxFlagsV1,
  mapConfigParamV1,
  encode: defaultCodec.encode,
  decode: defaultCodec.decode,
  encodeOpen: defaultCodec.encodeOpen,
  encodeClose: defaultCodec.encodeClose,
  encodeReadVersion: defaultCodec.encodeReadVersion,
  encodeConnect: defaultCodec.encodeConnect,
  encodeDisconnect: defaultCodec.encodeDisconnect,
  encodeLogicalConnect: defaultCodec.encodeLogicalConnect,
  encodeLogicalDisconnect: defaultCodec.encodeLogicalDisconnect,
  encodeWrite: defaultCodec.encodeWrite,
  encodeRead: defaultCodec.encodeRead,
  encodeStartFilter: defaultCodec.encodeStartFilter,
  encodeStopFilter: defaultCodec.encodeStopFilter,
  encodeStartPeriodic: defaultCodec.encodeStartPeriodic,
  encodeStopPeriodic: defaultCodec.encodeStopPeriodic,
  encodeIoctl: defaultCodec.encodeIoctl,
  encodeEthDiscovery: defaultCodec.encodeEthDiscovery,
  encodeDoipRoutingActivation,
  parseBmwDiscovery: defaultCodec.parseBmwDiscovery,
  parseIso13400Discovery: defaultCodec.parseIso13400Discovery,
  encodeSetConfig: defaultCodec.encodeSetConfig,
  encodeGetConfig: defaultCodec.encodeGetConfig,
  encodeFunctLookup: defaultCodec.encodeFunctLookup,
  encodeTp20RequestConnection: defaultCodec.encodeTp20RequestConnection,
  encodeTp16RequestConnection: defaultCodec.encodeTp16RequestConnection,
  encodeCustomFeature: defaultCodec.encodeCustomFeature,
  encodeWifiSsidPw,
  encodeEraseType,
  encodeEraseFlash,
  encodeProgramFlash,
  parseWifiState,
  parseWifiScan,
  parseFlashInfo,
  parseResponse: defaultCodec.parseResponse,
  parseError: defaultCodec.parseError,
  parseOpen: defaultCodec.parseOpen,
  parseChannel: defaultCodec.parseChannel,
  parseLogicalConnect: defaultCodec.parseLogicalConnect,
  parseId: defaultCodec.parseId,
  parseRead: defaultCodec.parseRead,
  parseWrite: defaultCodec.parseWrite,
  parseIoctl: defaultCodec.parseIoctl,
  parseOutEvent: defaultCodec.parseOutEvent,
  throwIfError
}
