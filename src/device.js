'use strict'

const EventEmitter = require('events')
const RdcommClient = require('./rdcomm')
const codec = require('./codec')
const { J2534Protocol } = require('./j2534')
const { BledlLink } = require('./bledl')
const { BleGatt } = require('./ble-gatt')
const { scanLan } = require('./mdns')
const {
  RDCOMM,
  BLE,
  Ioctl,
  CustomFeature,
  EraseType,
  ConfigParam,
  RxStatus,
  Protocol,
  ConnectFlag,
  TxFlag,
  FilterType,
  ErrorCode
} = require('./constants')
const { DFirstJ2534Error } = require('./errors')
const {
  deviceCodeFromName,
  inferProVersion,
  openVersionTryOrder,
  parseOpenVersionString,
  normalizeProVersion
} = require('./proVersion')

function channelIdOf(channel) {
  if (channel && typeof channel === 'object' && channel.id != null) {
    return channel.id
  }
  return channel
}

class PassThruChannel {
  /**
   * @param {DFirstJ2534} device
   * @param {number} id
   * @param {{physical?: boolean, protocol?: number}} meta
   */
  constructor(device, id, meta = {}) {
    this.device = device
    this.id = id
    this.physical = !!meta.physical
    this.protocol = meta.protocol
  }

  async disconnect() {
    // CLEAR_RX 在关通道前调用（请求路径不清）
    await this.ioctl(Ioctl.CLEAR_RX_QUEUE).catch(() => {})
    return this.physical
      ? this.device.passThruDisconnect(this.id)
      : this.device.passThruDisconnectLogical(this.id)
  }

  writeMsgs(msgs, options) {
    return this.device.passThruWriteMsgs(this.id, msgs, options)
  }

  readMsgs(options) {
    return this.device.passThruReadMsgs(this.id, options)
  }

  /**
   * UDS request/response on this channel. `prefix` is prepended on TX and stripped on RX
   * (ETH_BMW: Src+Tgt 2 bytes; ISO13400: TargetAddr 2 bytes). Firmware wraps HSFZ / DoIP.
   * NRC 0x78 (responsePending) keeps waiting.
   */
  async request(payload, options = {}) {
    const prefix = options.prefix != null && options.prefix !== ''
      ? codec.toBuf(options.prefix)
      : Buffer.alloc(0)
    const udsIn = codec.toBuf(payload)
    const data = Buffer.concat([prefix, udsIn])
    await this.writeMsgs(
      [{ txFlags: options.txFlags || 0, data }],
      { timeout: options.writeTimeout || options.timeout }
    )
    let deadline = Date.now() + (options.timeout || 2000)
    const pendingExtend = options.pendingExtendMs != null ? options.pendingExtendMs : 5000
    while (Date.now() < deadline) {
      const msgs = await this.readMsgs({
        num: 8,
        timeout: Math.min(400, Math.max(40, deadline - Date.now()))
      })
      for (const msg of msgs) {
        if (msg.rxStatus & (RxStatus.TX_MSG_TYPE | RxStatus.TX_SUCCESS | RxStatus.START_OF_MESSAGE)) {
          continue
        }
        if (!msg.data || msg.data.length <= prefix.length) {
          continue
        }
        const uds = msg.data.slice(prefix.length)
        if (!uds.length) {
          continue
        }
        if (uds[0] === 0x7F && uds.length >= 3 && uds[2] === 0x78) {
          if (pendingExtend) {
            deadline = Math.max(deadline, Date.now() + pendingExtend)
          }
          continue
        }
        return { data: uds, raw: msg }
      }
    }
    throw new DFirstJ2534Error('no UDS response', { source: 'j2534' })
  }

  startMsgFilter(filter) {
    return this.device.passThruStartMsgFilter(this.id, filter)
  }

  stopMsgFilter(filterId) {
    return this.device.passThruStopMsgFilter(this.id, filterId)
  }

  startPeriodicMsg(msg) {
    return this.device.passThruStartPeriodicMsg(this.id, msg)
  }

  stopPeriodicMsg(msgId) {
    return this.device.passThruStopPeriodicMsg(this.id, msgId)
  }

  ioctl(ioctlId, input, timeout) {
    return this.device.passThruIoctl(this.id, ioctlId, input, timeout)
  }

  setConfig(items) {
    return this.device.passThruSetConfig(this.id, items)
  }

  /**
   * J1850 PWM：把地址写入功能查找表。驱动只收 dest==NODE_ADDRESS 或表内地址。
   * OBD 应答头是 41 6B xx，必须加 0x6B，否则总线上有帧也进不了 ReadMsgs。
   */
  addFunctLookup(addrs) {
    return this.ioctl(Ioctl.ADD_TO_FUNCT_MSG_LOOKUP_TABLE, this.device.codec.encodeFunctLookup(addrs))
  }

  clearFunctLookup() {
    return this.ioctl(Ioctl.CLEAR_FUNCT_MSG_LOOKUP_TABLE)
  }

  /**
   * K 线 FIVE_BAUD_INIT。Input 1 字节地址，Output 2 字节 Keyword。
   * 5 波特发地址约 2s，BLE/LAN 默认等 20s。
   */
  async fiveBaudInit(addr, opts = {}) {
    if (opts.fiveBaudMod != null) {
      await this.setConfig([{ paramId: ConfigParam.FIVE_BAUD_MOD, value: opts.fiveBaudMod }])
    }
    const res = await this.device.passThruIoctl(
      this.id,
      Ioctl.FIVE_BAUD_INIT,
      Buffer.from([addr & 0xff]),
      opts.timeout || 20000
    )
    const kw = res.output || Buffer.alloc(0)
    return {
      ...res,
      kb1: kw.length >= 1 ? kw[0] : 0,
      kb2: kw.length >= 2 ? kw[1] : 0
    }
  }

  /** K 线 FAST_INIT。msg 为 StartCommunication（不含校验，固件会补）。 */
  fastInit(msg, opts = {}) {
    const input = msg == null || msg === '' ? Buffer.alloc(0) : codec.toBuf(msg)
    return this.device.passThruIoctl(this.id, Ioctl.FAST_INIT, input, opts.timeout || 8000)
  }

  connectLogical(opts) {
    if (!this.physical) {
      throw new DFirstJ2534Error('logical connect requires a physical channel')
    }
    return this.device.passThruConnectLogical(this.id, opts)
  }
}

class DFirstJ2534 extends EventEmitter {
  /**
   * DFirst J2534 VCI（S2 / QX-A 等机型）。
   * 协议版本：A5/A6/C0/S0/S1/S2/D0 → V2；A0–A4 → V1。可 `options.proVersion` 覆盖。
   * @param {{transport?: 'lan'|'ble', host?: string, port?: number, timeout?: number, name?: string, deviceId?: string, blecfg?: string, proVersion?: 'V1'|'V2'}} options
   */
  constructor(options = {}) {
    super()
    this.transport = options.transport || (options.host ? 'lan' : 'ble')
    this.rdcomm = null
    this.bledl = null
    this.info = null
    this.opened = false
    this._configId = 0
    this.deviceCode = ''
    this._proVersionOverride = options.proVersion
      ? normalizeProVersion(options.proVersion)
      : null
    this._setProVersion(this._proVersionOverride || 'V2')

    if (this.transport === 'ble') {
      this.bledl = new BledlLink(options)
      this.bledl.on('trace', (msg) => this.emit('trace', msg))
      this.bledl.on('close', () => {
        this.opened = false
        this.emit('close')
      })
    } else {
      if (!options.host) {
        throw new DFirstJ2534Error('options.host is required (device Ethernet IP on e0)')
      }
      this.rdcomm = new RdcommClient(options)
      this.rdcomm.on('event', (evt) => this._onEvent(evt))
      this.rdcomm.on('error', (err) => this.emit('error', err))
      this.rdcomm.on('close', () => {
        this.opened = false
        this.emit('close')
      })
    }

    this.j2534 = new J2534Protocol(this)
  }

  /** @returns {'V1'|'V2'} 只读；OPEN 成功后可能按设备回报校正。 */
  get proVersion() {
    return this._proVersion
  }

  _setProVersion(ver) {
    const v = normalizeProVersion(ver) === 'V1' ? 'V1' : 'V2'
    this._proVersion = v
    this.codec = codec.createCodec(v)
  }

  _inferProVersionFromInfo() {
    const name = (this.info && (this.info.name || this.info.psn)) || ''
    this.deviceCode = deviceCodeFromName(name) || this.deviceCode
    if (this._proVersionOverride === 'V1' || this._proVersionOverride === 'V2') {
      this._setProVersion(this._proVersionOverride)
      return
    }
    this._setProVersion(inferProVersion({
      name,
      psn: this.info && this.info.psn,
      deviceCode: this.deviceCode
    }))
  }

  get connected() {
    return this.transport === 'ble' ? this.bledl.connected : this.rdcomm.connected
  }

  static scanBle(opts) {
    return new BleGatt(opts).scan(opts)
  }

  /** DNS-SD `_rdcomm._tcp.local` — same service Bonjour browses. Returns `{ host, port, name, psn }`. */
  static scanLan(opts) {
    return scanLan(opts)
  }

  async connect(target) {
    if (this.transport === 'ble') {
      this.info = await this.bledl.connect(target)
      if (this.info && this.info.name && this.info.name.startsWith(BLE.NAME_PREFIX)) {
        this.info.psn = this.info.name.slice(BLE.NAME_PREFIX.length)
      }
      this._inferProVersionFromInfo()
      this.emit('connected', this.info)
      return this.info
    }
    await this.rdcomm.connect()
    this.info = await this._register()
    await this._setLocalRegistered()
    this._inferProVersionFromInfo()
    this.emit('connected', this.info)
    return this.info
  }

  async disconnect() {
    try {
      if (this.opened) {
        await this.passThruClose().catch(() => {})
      }
      if (this._configId) {
        await this.clearConfig().catch(() => {})
      }
    } finally {
      if (this.bledl) {
        await this.bledl.close().catch(() => {})
      }
      if (this.rdcomm) {
        this.rdcomm.close()
      }
    }
  }

  /** J2534 command payload in, ErrorCode+... buffer out. BLE = BLEDL; LAN = RDComm 0x8C. */
  async sendJ2534(payload, timeout) {
    if (this.bledl) {
      return this.bledl.request(payload, timeout)
    }
    const ack = await this.rdcomm.send(RDCOMM.RC.J2534Command, payload, { timeout })
    return ack.data
  }

  _applyOpenVersionString(versionStr) {
    const parsed = parseOpenVersionString(versionStr)
    if (parsed.proVersion && !this._proVersionOverride) {
      this._setProVersion(parsed.proVersion)
    }
    if (parsed.sn) {
      this.deviceCode = deviceCodeFromName(parsed.sn) || this.deviceCode
    }
    return versionStr
  }

  async passThruOpen() {
    if (this.opened) {
      return this.passThruReadVersion()
    }
    if (!this._proVersionOverride) {
      this._inferProVersionFromInfo()
    }
    const order = openVersionTryOrder(this.proVersion)
    let lastErr = null
    for (let i = 0; i < order.length; i++) {
      this._setProVersion(order[i])
      try {
        // 与 Activer 一致：先尝试 CLOSE 再 OPEN
        await this._j2534(this.codec.encodeClose()).catch(() => {})
        const parsed = this.codec.parseOpen(await this._j2534(this.codec.encodeOpen()))
        this.opened = true
        this._applyOpenVersionString(parsed.version)
        return parsed.version
      } catch (err) {
        lastErr = err
        if (err.code === ErrorCode.DEVICE_IN_USE) {
          this.opened = true
          try {
            return await this.passThruReadVersion()
          } catch {
            return '(already open)'
          }
        }
        // 版本不对时再试下一档；其它错误且已是最后一档则抛出
        if (i === order.length - 1) {
          throw err
        }
      }
    }
    throw lastErr || new DFirstJ2534Error('J2534 OPEN failed', { source: 'j2534' })
  }

  async passThruClose() {
    await this._j2534(this.codec.encodeClose())
    this.opened = false
  }

  async passThruReadVersion() {
    const parsed = this.codec.parseOpen(await this._j2534(this.codec.encodeReadVersion()))
    this._applyOpenVersionString(parsed.version)
    return parsed.version
  }

  /**
   * @param {{protocol: number, baud: number, flags?: number, pinSelect?: number}} opts
   * @returns {Promise<PassThruChannel>}
   */
  async passThruConnect(opts) {
    const parsed = this.codec.parseChannel(
      await this._j2534(this.codec.encodeConnect(opts), opts.timeout)
    )
    return new PassThruChannel(this, parsed.channelId, {
      physical: true,
      protocol: opts.protocol
    })
  }

  async passThruDisconnect(channel) {
    await this._j2534(this.codec.encodeDisconnect(channelIdOf(channel)))
  }

  /**
   * @param {number|PassThruChannel} phyChannel
   * @param {{protocol: number, flags?: number, localTxFlags?: number, remoteTxFlags?: number, localAddress?: Buffer, remoteAddress?: Buffer, remoteIP?: string|number, remotePort?: number, localPort?: number, timeout?: number}} opts
   */
  async passThruConnectLogical(phyChannel, opts) {
    const parsed = this.codec.parseLogicalConnect(
      await this._j2534(this.codec.encodeLogicalConnect(channelIdOf(phyChannel), opts), opts.timeout)
    )
    return new PassThruChannel(this, parsed.channelId, {
      physical: false,
      protocol: opts.protocol
    })
  }

  async passThruDisconnectLogical(channel) {
    await this._j2534(this.codec.encodeLogicalDisconnect(channelIdOf(channel)))
  }

  /**
   * @param {number|PassThruChannel} channel
   * @param {{handle?: number, txFlags?: number, data: Buffer|string|number[]}[]} msgs
   */
  async passThruWriteMsgs(channel, msgs, options = {}) {
    const list = Array.isArray(msgs) ? msgs : [msgs]
    return this.codec.parseWrite(await this._j2534(
      this.codec.encodeWrite(channelIdOf(channel), list),
      options.timeout
    ))
  }

  /**
   * @param {number|PassThruChannel} channel
   * @param {{num?: number, timeout?: number}} options
   */
  async passThruReadMsgs(channel, options = {}) {
    const timeout = options.timeout || 1000
    const parsed = this.codec.parseRead(
      await this._j2534(this.codec.encodeRead(channelIdOf(channel), options), timeout + 500)
    )
    return parsed.messages
  }

  async passThruStartMsgFilter(channel, filter) {
    const parsed = this.codec.parseId(
      await this._j2534(this.codec.encodeStartFilter(channelIdOf(channel), filter))
    )
    return parsed.id
  }

  async passThruStopMsgFilter(channel, filterId) {
    await this._j2534(this.codec.encodeStopFilter(channelIdOf(channel), filterId))
  }

  async passThruStartPeriodicMsg(channel, msg) {
    const parsed = this.codec.parseId(
      await this._j2534(this.codec.encodeStartPeriodic(channelIdOf(channel), msg))
    )
    return parsed.id
  }

  async passThruStopPeriodicMsg(channel, msgId) {
    await this._j2534(this.codec.encodeStopPeriodic(channelIdOf(channel), msgId))
  }

  async passThruSetConfig(channel, items) {
    return this.passThruIoctl(channel, Ioctl.SET_CONFIG, this.codec.encodeSetConfig(items))
  }

  async passThruIoctl(channel, ioctlId, input, timeout) {
    return this.codec.parseIoctl(
      await this._j2534(
        this.codec.encodeIoctl(channelIdOf(channel) || 0, ioctlId, input || Buffer.alloc(0)),
        timeout
      )
    )
  }

  /** OBD pin voltage in millivolts. Pin 16 is supply. */
  async readPinVoltage(pin) {
    let input
    if (this.proVersion === 'V1') {
      input = Buffer.from([pin & 0xff])
    } else {
      input = Buffer.alloc(4)
      input.writeUInt32LE(pin, 0)
    }
    const res = await this.passThruIoctl(0, Ioctl.READ_PIN_VOLTAGE, input)
    if (res.output.length >= 4) {
      return this.proVersion === 'V1'
        ? res.output.readUInt32BE(0)
        : res.output.readUInt32LE(0)
    }
    if (res.output.length >= 2) {
      return this.proVersion === 'V1'
        ? res.output.readUInt16BE(0)
        : res.output.readUInt16LE(0)
    }
    return res.output.length ? res.output[0] : 0
  }

  async _ensureOpen() {
    if (!this.opened) {
      await this.j2534.open()
    }
  }

  /**
   * QXS1/QXS2 ESP32 STA：CUSTOM_FEATURE GET_WIFI_STATE (0x15)。
   * AT 最长约 20s，BLE 应答超时默认 25s。
   */
  async wifiGetState(timeout = 25000) {
    await this._ensureOpen()
    const res = await this.j2534.customFeature(CustomFeature.GET_WIFI_STATE, Buffer.alloc(0), timeout)
    return codec.parseWifiState(res.output)
  }

  /** CUSTOM_FEATURE SCAN_WIFI (0x18)。CWLAP 最长约 20s。 */
  async wifiScan(timeout = 30000) {
    await this._ensureOpen()
    const res = await this.j2534.customFeature(CustomFeature.SCAN_WIFI, Buffer.alloc(0), timeout)
    return codec.parseWifiScan(res.output)
  }

  /** CUSTOM_FEATURE SET_WIFI_SSID_PW (0x16)。密码至少 2 字节（固件 InputLength 检查）。 */
  async wifiConnect(ssid, password, timeout = 25000) {
    await this._ensureOpen()
    await this.j2534.customFeature(
      CustomFeature.SET_WIFI_SSID_PW,
      this.codec.encodeWifiSsidPw(ssid, password),
      timeout
    )
    return { ssid: String(ssid || '') }
  }

  /** CUSTOM_FEATURE DISC_WIFI (0x17) */
  async wifiDisconnect(timeout = 15000) {
    await this._ensureOpen()
    await this.j2534.customFeature(CustomFeature.DISC_WIFI, Buffer.alloc(0), timeout)
    return { ok: true }
  }

  /**
   * 升级 App：CUSTOM_FEATURE ENTER_UPGRADE_MODE → ERASE → PROGRAM → CHECK → EXIT。
   * 写到空闲槽（当前槽的另一半）。bin 需带鉴权头。默认写完复位。
   */
  async upgradeFirmware(bin, opts = {}) {
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {}
    const chunkSize = Math.max(16, Math.min(opts.chunkSize || (this.transport === 'ble' ? 1024 : 2048), 2048) & ~15)
    const reboot = opts.reboot !== false
    const buf = Buffer.isBuffer(bin) ? bin : Buffer.from(bin)
    if (!buf.length) {
      throw new DFirstJ2534Error('empty firmware', { source: 'upgrade' })
    }
    if (buf.length > 0x80000) {
      throw new DFirstJ2534Error('firmware larger than APP slot (512KB)', { source: 'upgrade' })
    }

    await this._ensureOpen()
    const cf = (id, input, timeout) => this.j2534.customFeature(id, input, timeout)

    onProgress({ phase: 'enter', percent: 0, msg: '进入升级模式' })
    await cf(CustomFeature.ENTER_UPGRADE_MODE, this.codec.encodeEraseType(EraseType.APP), 15000)

    try {
      const infoRes = await cf(CustomFeature.GET_FLASH_INFO, Buffer.alloc(0), 10000)
      const info = codec.parseFlashInfo(infoRes.output)
      const pageSize = info.pageSize || 0x1000
      const maxSize = (info.endAddr || 0x7FFFF) + 1
      if (buf.length > maxSize) {
        throw new DFirstJ2534Error(`firmware ${buf.length} > slot ${maxSize}`, { source: 'upgrade' })
      }
      const pages = Math.max(1, Math.ceil(buf.length / pageSize))
      onProgress({
        phase: 'erase',
        percent: 2,
        msg: `擦除 ${pages} 页 × ${pageSize}`,
        pages,
        pageSize,
        info
      })
      await cf(
        CustomFeature.ERASE_FLASH,
        this.codec.encodeEraseFlash(info.startAddr || 0, pages),
        opts.eraseTimeout || 120000
      )

      for (let off = 0; off < buf.length; off += chunkSize) {
        const n = Math.min(chunkSize, buf.length - off)
        let chunk = Buffer.from(buf.slice(off, off + n))
        if (chunk.length & 15) {
          const pad = Buffer.alloc((chunk.length + 15) & ~15, 0xff)
          chunk.copy(pad)
          chunk = pad
        }
        if (!chunk.every((b) => b === 0xff)) {
          await cf(
            CustomFeature.PROGRAM_FLASH,
            this.codec.encodeProgramFlash(off, chunk),
            opts.programTimeout || 20000
          )
        }
        const written = Math.min(off + n, buf.length)
        onProgress({
          phase: 'program',
          percent: 5 + Math.floor((written / buf.length) * 90),
          msg: `写入 ${written}/${buf.length}`,
          offset: written,
          total: buf.length
        })
      }

      onProgress({ phase: 'check', percent: 96, msg: '校验' })
      await cf(CustomFeature.CHECK_FLASH, Buffer.alloc(0), 20000)
      onProgress({ phase: 'exit', percent: 98, msg: '退出升级模式' })
      await cf(CustomFeature.EXIT_UPGRADE_MODE, Buffer.alloc(0), 10000)
    } catch (err) {
      await cf(CustomFeature.EXIT_UPGRADE_MODE, Buffer.alloc(0), 10000).catch(() => {})
      throw err
    }

    if (reboot) {
      onProgress({ phase: 'reboot', percent: 99, msg: '复位设备' })
      await cf(CustomFeature.RESET_DEVICE, Buffer.alloc(0), 5000).catch(() => {})
    }
    onProgress({ phase: 'done', percent: 100, msg: '完成' })
    return { ok: true, size: buf.length, rebooted: reboot }
  }

  /**
   * Apply the firmware JSON session (same as RDComm ServiceConfig).
   * Device opens J2534 itself. Incoming frames arrive as `message` events.
   */
  async loadJsonConfig(config, configId = 0x12345678) {
    if (!this.rdcomm) {
      throw new DFirstJ2534Error('JSON config is LAN/RDComm only', { source: 'ble' })
    }
    const header = Buffer.alloc(8)
    header.writeUInt32LE(0xffffffff, 0)
    header.writeUInt32LE(configId, 4)
    const json = typeof config === 'string' ? config : JSON.stringify(config)
    const ack = await this.rdcomm.send(
      RDCOMM.RC.ServiceConfig,
      Buffer.concat([header, Buffer.from(json, 'ascii')]),
      { timeout: 8000 }
    )
    const jerr = ack.data.length >= 4 ? ack.data.readUInt32LE(0) : 0
    if (jerr) {
      const log = ack.data.length > 4 ? ack.data.slice(4).toString('ascii') : ''
      throw new DFirstJ2534Error(`JSON config failed 0x${jerr.toString(16)} ${log}`, {
        code: jerr,
        source: 'j2534'
      })
    }
    this._configId = configId
    this.opened = true
    return configId
  }

  async clearConfig() {
    if (!this.rdcomm) {
      this._configId = 0
      return
    }
    await this.rdcomm.send(RDCOMM.RC.ServiceClear, Buffer.alloc(0))
    this._configId = 0
    this.opened = false
  }

  /**
   * ISO15765 on CAN (default OBD: 11-bit 500k, pins 6/14).
   * LOGICALCONNECT: ConnectFlags, LocalTxFlags, RemoteTxFlags, LocalAddress[5], RemoteAddress[5].
   * Point-to-point: connectFlags=0 (firmware builds FLOW_CONTROL from addresses).
   * Filter channel: connectFlags=ISO15765_FILTER, then START_MSG_FILTER.
   * Mixed addressing: TxFlags ISO15765_ADDR_TYPE (0x80) + 5th address byte.
   * Padding: FRAME_PAD|PADDING_VALID (0x800040); padValue merges into TxFlags high byte
   *   (firmware prefers that over SET_CONFIG PAD_VALUE when PaddingValid is set).
   * Flow control (after open): iso.setConfig BS/STMIN/BS_TX/STMIN_TX/N_CR — see PROTOCOL.md.
   * Pass `physicalChannel` to LOGICALCONNECT on an already-open CAN channel.
   *
   * @param {object} [opts]
   * @param {number} [opts.txId=0x7E0]
   * @param {number} [opts.rxId=0x7E8]
   * @param {number} [opts.connectFlags=0]
   * @param {number} [opts.localTxFlags=0]
   * @param {number} [opts.remoteTxFlags] default ISO15765_PAD
   * @param {number|null} [opts.padValue] 0–0xFF into TxFlags[31:24] when FRAME_PAD
   * @param {string|Buffer} [opts.localAddress] 5-byte addr hex
   * @param {string|Buffer} [opts.remoteAddress]
   * @param {object} [opts.physicalChannel] existing CAN PassThruChannel
   */
  async openIso15765({
    baud = 500000,
    flags = ConnectFlag.CAN_ID_BOTH,
    pinSelect = 0,
    txId = 0x7E0,
    rxId = 0x7E8,
    txAe = null,
    rxAe = null,
    connectFlags = 0,
    localTxFlags = 0,
    remoteTxFlags,
    txFlags,
    localAddress,
    remoteAddress,
    protocol = Protocol.ISO15765,
    physicalChannel = null,
    fdRate = 0,
    padValue = null
  } = {}) {
    if (!this.opened) {
      await this.passThruOpen()
    }
    let can = physicalChannel
    let ownsPhysical = false
    if (!can) {
      can = await this.passThruConnect({
        protocol: Protocol.CAN,
        baud,
        flags,
        pinSelect
      })
      ownsPhysical = true
    }
    if (fdRate) {
      await can.setConfig([{
        paramId: ConfigParam.CAN_FD_DATA_PHASE_RATE,
        value: fdRate
      }])
    }
    const localAddr = (localAddress != null && localAddress !== '')
      ? codec.addr5(localAddress)
      : codec.canId5(rxId, rxAe || 0)
    const remoteAddr = (remoteAddress != null && remoteAddress !== '')
      ? codec.addr5(remoteAddress)
      : codec.canId5(txId, txAe || 0)
    let rtf = remoteTxFlags != null ? remoteTxFlags : (txFlags != null ? txFlags : TxFlag.ISO15765_PAD)
    let ltf = localTxFlags || 0
    if (fdRate) {
      rtf |= TxFlag.CANFD_FORMAT | TxFlag.CANFD_BRS
    }
    // PaddingValid 时固件用 TxFlags 高字节，忽略仅 SET_CONFIG；把 padValue 并进高 8 位
    if (padValue != null) {
      const pad = padValue & 0xff
      if (rtf & TxFlag.ISO15765_FRAME_PAD) {
        rtf = ((rtf & 0x00ffffff) | (pad << 24) | TxFlag.PADDING_VALID) >>> 0
      }
      if (ltf & TxFlag.ISO15765_FRAME_PAD) {
        ltf = ((ltf & 0x00ffffff) | (pad << 24) | TxFlag.PADDING_VALID) >>> 0
      }
    }
    const mixed = !!(localAddr[4] || remoteAddr[4] ||
      (ltf & TxFlag.ISO15765_ADDR_TYPE) || (rtf & TxFlag.ISO15765_ADDR_TYPE))
    if (mixed) {
      ltf |= TxFlag.ISO15765_ADDR_TYPE
      rtf |= TxFlag.ISO15765_ADDR_TYPE
    } else if (localAddr.readUInt32BE(0) > 0x7FF || remoteAddr.readUInt32BE(0) > 0x7FF) {
      ltf |= TxFlag.CAN_29BIT_ID
      rtf |= TxFlag.CAN_29BIT_ID
    }
    const logFlags = connectFlags >>> 0
    const wantFilter = !!(logFlags & ConnectFlag.ISO15765_FILTER) ||
      protocol === Protocol.ISO15765_FILTER
    // V1 过滤通道：ProtocolID=0x201，线上 ConnectFlags 不含 FILTER 位
    const wireProto = (wantFilter && this.proVersion === 'V1')
      ? Protocol.ISO15765_FILTER
      : (protocol || Protocol.ISO15765)
    const wireFlags = (wantFilter && this.proVersion === 'V1')
      ? (logFlags & ~ConnectFlag.ISO15765_FILTER)
      : logFlags
    const iso = await can.connectLogical({
      protocol: wireProto,
      flags: wireFlags,
      localTxFlags: ltf,
      remoteTxFlags: rtf,
      localAddress: localAddr,
      remoteAddress: remoteAddr
    })
    if (wantFilter) {
      await iso.startMsgFilter({
        type: FilterType.FLOW_CONTROL,
        localTxFlags: ltf,
        remoteTxFlags: rtf,
        mask: codec.canId5(0xFFFFFFFF, mixed ? 0xFF : 0),
        pattern: localAddr,
        flowControl: remoteAddr
      })
    }
    iso.txId = remoteAddr.readUInt32BE(0)
    iso.rxId = localAddr.readUInt32BE(0)
    iso.txAe = mixed ? remoteAddr[4] : null
    iso.rxAe = mixed ? localAddr[4] : null
    iso.txFlags = rtf
    iso.connectFlags = logFlags
    iso.localTxFlags = ltf
    iso.remoteTxFlags = rtf
    iso.localAddress = localAddr
    iso.remoteAddress = remoteAddr
    iso.physicalChannel = can
    iso.ownsPhysical = ownsPhysical
    iso.request = async (payload, options) => this._isoRequest(iso, payload, options)
    return iso
  }

  async _isoRequest(iso, payload, options = {}) {
    const udsIn = codec.toBuf(payload)
    const mixed = iso.txAe != null || iso.rxAe != null ||
      !!(iso.txFlags & TxFlag.ISO15765_ADDR_TYPE)
    const hdr = mixed
      ? Buffer.concat([codec.canId4(iso.txId), Buffer.from([(iso.txAe || 0) & 0xff])])
      : codec.canId4(iso.txId)
    const data = Buffer.concat([hdr, udsIn])
    await iso.writeMsgs([{ txFlags: iso.txFlags, data }])
    const timeout = options.timeout || 2000
    const deadline = Date.now() + timeout
    let saw = 0
    let lastStatus = 0
    let lastHex = ''
    while (Date.now() < deadline) {
      const wait = Math.min(options.pollMs != null ? options.pollMs : 300, Math.max(40, deadline - Date.now()))
      const msgs = await iso.readMsgs({
        num: 8,
        timeout: wait
      })
      for (const msg of msgs) {
        saw += 1
        lastStatus = msg.rxStatus >>> 0
        lastHex = msg.data ? msg.data.toString('hex') : ''
        if (msg.rxStatus & (RxStatus.TX_MSG_TYPE | RxStatus.TX_SUCCESS | RxStatus.TX_FAILED)) {
          continue
        }
        const addr = !!(msg.rxStatus & RxStatus.ISO15765_ADDR_TYPE) || mixed
        const skip = addr ? 5 : 4
        const extra = msg.extraDataIndex || 0
        const end = (extra > skip && extra <= msg.data.length) ? extra : msg.data.length
        if ((msg.rxStatus & RxStatus.START_OF_MESSAGE) && end <= skip) {
          continue
        }
        const uds = msg.data.slice(skip, end)
        if (!uds.length) {
          continue
        }
        if (uds[0] === 0x7F && uds.length >= 3 && uds[2] === 0x78) {
          continue
        }
        return { data: uds, raw: msg, frames: [msg] }
      }
    }
    throw new DFirstJ2534Error(
      `ISO15765 no response` +
        (saw
          ? ` (saw ${saw} ind, last RxStatus=0x${lastStatus.toString(16)} data=${lastHex.slice(0, 48)})`
          : ' (no indication)'),
      { source: 'j2534' }
    )
  }

  async _j2534(cmd, timeout) {
    return this.sendJ2534(cmd, timeout)
  }

  async _register() {
    const random = Buffer.alloc(4)
    random.writeUInt32LE((Math.random() * 0xffffffff) >>> 0, 0)
    const ack = await this.rdcomm.send(RDCOMM.RC.RequestRegister, random)
    const text = ack.data.toString('ascii').replace(/\0+$/, '')
    const parts = text.split(',')
    return {
      psn: parts[0] || '',
      appVersion: parts[1] || '',
      hwVersion: parts[2] || '',
      bootVersion: parts[3] || '',
      raw: text,
      host: this.rdcomm.host,
      port: this.rdcomm.port,
      name: (parts[0] ? BLE.NAME_PREFIX + parts[0] : '') || this.rdcomm.host
    }
  }

  async _setLocalRegistered() {
    const data = Buffer.alloc(8)
    data.writeUInt32LE(RDCOMM.RST_Status, 0)
    data.writeUInt32LE(RDCOMM.RS_LOCAL_REGISTERED, 4)
    await this.rdcomm.send(RDCOMM.RC.SetState, data)
  }

  _onEvent(evt) {
    if (evt.command === RDCOMM.RC.J2534OutEvent) {
      const messages = codec.parseOutEvent(evt.data)
      for (const msg of messages) {
        this.emit('message', msg)
      }
    }
    this.emit('event', evt)
  }
}

module.exports = { DFirstJ2534, PassThruChannel }
