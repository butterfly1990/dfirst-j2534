'use strict'

const EventEmitter = require('events')
const path = require('path')
const { BLE } = require('./constants')
const { DFirstJ2534Error } = require('./errors')

function loadNoble() {
  const names = ['@stoprocent/noble', '@abandonware/noble', 'noble']
  const paths = [
    process.cwd(),
    path.join(__dirname, '..'),
    path.join(__dirname, '../..')
  ]
  for (const name of names) {
    try {
      return require(name)
    } catch (_) { /* next */ }
    try {
      return require(require.resolve(name, { paths }))
    } catch (_) { /* next */ }
  }
  throw new DFirstJ2534Error(
    'BLE adapter not found. Install one of: npm i @stoprocent/noble  (Windows WinRT) or @abandonware/noble',
    { source: 'ble' }
  )
}

function uuid16(u) {
  return String(u || '').replace(/-/g, '').toLowerCase().slice(-4)
}

function parseBlecfg(blecfg) {
  if (!blecfg) {
    return null
  }
  const p = String(blecfg).toLowerCase().replace(/o/g, '0').split('-')
  if (p.length < 4) {
    return null
  }
  return {
    service: p[0],
    write: p[1],
    notify: p[3],
    maxPagLen: p[4] ? parseInt(p[4], 16) : 0x200,
    mtu: p[5] ? parseInt(p[5], 16) : 0xc0
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A0/A1 等老机广播里常没有 localName，但会带 FFE0；S 系列带 A002/FEE0。 */
const SCAN_SERVICE_HINTS = new Set(
  (BLE.PROFILES || []).map((p) => String(p.service).toLowerCase()).concat(['ffe0', 'ffe1', 'fee0', 'a002'])
)

function advLocalName(advertisement) {
  if (!advertisement) return ''
  return String(advertisement.localName || advertisement.completeLocalName || '').trim()
}

function advServiceHints(advertisement) {
  const out = new Set()
  const lists = [
    advertisement && advertisement.serviceUuids,
    advertisement && advertisement.serviceData && Object.keys(advertisement.serviceData)
  ]
  for (const list of lists) {
    if (!list) continue
    for (const u of list) {
      const id = uuid16(u)
      if (id) out.add(id)
    }
  }
  return [...out]
}

function matchesScanFilter(name, serviceHints, namePrefix) {
  const prefix = String(namePrefix || '').trim()
  if (!prefix) return true
  if (name && name.toUpperCase().startsWith(prefix.toUpperCase())) return true
  // 无名称时：广播里出现已知 GATT 服务也收下（QX-A0/A1 的 FFE0 很常见）
  if (!name && serviceHints.some((s) => SCAN_SERVICE_HINTS.has(s))) return true
  return false
}

function displayName(name, serviceHints, address) {
  if (name) return name
  const hint = serviceHints.find((s) => SCAN_SERVICE_HINTS.has(s))
  const short = address ? String(address).replace(/-/g, '').slice(-8) : ''
  return hint ? `(${hint.toUpperCase()}${short ? ' ' + short : ''})` : `(no-name ${short || '?'})`
}

/**
 * GATT write/notify. S2 ESP32 default: FEE0 / FEE1 write / FEE2 notify.
 */
class BleGatt extends EventEmitter {
  constructor(options = {}) {
    super()
    this.options = options
    this.noble = null
    this.peripheral = null
    this.writeChar = null
    this.chunk = options.chunk || BLE.WRITE_MAX
    this.profile = parseBlecfg(options.blecfg)
  }

  get connected() {
    return !!(this.peripheral && this.writeChar)
  }

  async scan({ namePrefix = BLE.NAME_PREFIX, timeout = 8000 } = {}) {
    const noble = loadNoble()
    const found = []
    await this._ready(noble)
    await this._stopScan(noble)
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        finish(null)
      }, timeout)
      const onDiscover = (p) => {
        const adv = p.advertisement || {}
        const name = advLocalName(adv)
        const serviceHints = advServiceHints(adv)
        if (!matchesScanFilter(name, serviceHints, namePrefix)) {
          return
        }
        const existing = found.find((x) => x.id === p.id)
        if (existing) {
          if (typeof p.rssi === 'number' && (existing.rssi == null || p.rssi > existing.rssi)) {
            existing.rssi = p.rssi
          }
          // 后续广播才带出 localName（A0/A1 在 Windows 上很常见）
          if (name && (!existing.name || existing.name.startsWith('('))) {
            existing.name = name
          }
          if (serviceHints.length) {
            existing.serviceHints = [...new Set([...(existing.serviceHints || []), ...serviceHints])]
          }
          return
        }
        const item = {
          id: p.id,
          address: p.address,
          name: displayName(name, serviceHints, p.address),
          rssi: p.rssi,
          serviceHints
        }
        found.push(item)
        this.emit('discover', item)
      }
      const finish = (err) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        noble.removeListener('discover', onDiscover)
        this._stopScan(noble).finally(() => {
          if (err) {
            reject(err)
          } else {
            found.sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))
            resolve(found)
          }
        })
      }
      noble.on('discover', onDiscover)
      // allowDuplicates=true：无名称的首包之后还能收到带 localName 的 scan response
      const start = typeof noble.startScanningAsync === 'function'
        ? noble.startScanningAsync([], true)
        : Promise.resolve().then(() => noble.startScanning([], true))
      start.catch((err) => finish(err))
    })
  }

  async connect(target) {
    const noble = loadNoble()
    this.noble = noble
    await this._ready(noble)
    await this._stopScan(noble)
    const isJdy = !!(this.profile && uuid16(this.profile.service) === 'ffe0')
    // JDY：空闲稍久就自己掉线，必须快连快挖；外层多试几次
    const maxAttempts = isJdy ? 5 : 2
    await delay(isJdy ? 300 : 150)
    let lastErr
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this._connectOnce(noble, target, attempt)
      } catch (err) {
        lastErr = err
        this.emit('trace', `gatt connect attempt ${attempt + 1}/${maxAttempts} fail: ${(err && err.message) || err}`)
        await this._hardClose()
        if (attempt + 1 < maxAttempts) {
          await delay(isJdy ? (900 + attempt * 400) : (350 + attempt * 250))
        }
      }
    }
    throw new DFirstJ2534Error((lastErr && lastErr.message) || 'ble connect failed', {
      source: 'ble',
      cause: lastErr
    })
  }

  async _connectOnce(noble, target, attempt = 0) {
    const t = typeof target === 'string' ? { id: target } : (target || {})
    const id = t.id || t.address || t.name
    const isJdy = !!(this.profile && uuid16(this.profile.service) === 'ffe0')
    const knownId = !!(t.id || t.address)

    // 先扫到设备（WinRT 需要广告缓存），再停扫连接
    let peripheral = null
    if (knownId && typeof noble.connectAsync === 'function') {
      try {
        peripheral = await this._resolve(noble, {
          ...t,
          timeout: isJdy ? (6000 + attempt * 800) : (2500 + attempt * 1000)
        })
      } catch (_) {
        peripheral = null
      }
      await this._stopScan(noble)
      // JDY 不宜久拖：空闲约 2s 就会断
      await delay(isJdy ? 200 : (120 + attempt * 80))

      this.emit('trace', `noble.connectAsync ${t.id || t.address}…`)
      try {
        peripheral = await noble.connectAsync(t.id || t.address, {
          timeout: isJdy ? 12000 : 8000
        })
      } catch (err) {
        if (peripheral && typeof peripheral.connectAsync === 'function') {
          await peripheral.connectAsync()
        } else if (peripheral) {
          await this._connectPeripheral(peripheral)
        } else {
          throw err
        }
      }
    } else {
      peripheral = await this._resolve(noble, t)
      await this._stopScan(noble)
      await delay(isJdy ? 200 : 200)
      if (peripheral.state !== 'connected') {
        if (typeof peripheral.connectAsync === 'function') {
          await peripheral.connectAsync()
        } else {
          await this._connectPeripheral(peripheral)
        }
      }
    }

    this.peripheral = peripheral
    this.emit('trace', `gatt linked state=${peripheral.state}`)

    await this._waitGattReady(peripheral, isJdy, attempt)

    const svcUuids = this.profile ? [String(this.profile.service)] : []
    const charUuids = this.profile
      ? [...new Set([this.profile.write, this.profile.notify].filter(Boolean).map(String))]
      : []

    let services = []
    let chars = []
    try {
      if (isJdy) {
        ;({ services, chars } = await this._discoverCharsJdy(peripheral, svcUuids, charUuids, attempt))
      } else {
        ;({ services, chars } = await this._discoverChars(peripheral, svcUuids, charUuids))
      }
    } catch (err) {
      if (!isJdy && peripheral.state === 'connected' &&
        typeof peripheral.discoverAllServicesAndCharacteristicsAsync === 'function') {
        this.emit('trace', `discover retry all: ${(err && err.message) || err}`)
        await delay(150)
        const r = await peripheral.discoverAllServicesAndCharacteristicsAsync()
        services = r.services || []
        chars = r.characteristics || []
      } else {
        throw new DFirstJ2534Error(
          `ble discover failed (${(err && err.message) || err})`,
          { source: 'ble', cause: err }
        )
      }
    }

    const pair = this._pickChars({ services, chars })
    if (!pair) {
      const uuids = (services || []).map((s) => uuid16(s.uuid)).filter(Boolean)
      throw new DFirstJ2534Error(
        `no matching GATT write/notify (services: ${uuids.join(',') || 'none'}; blecfg=${(this.options && this.options.blecfg) || '-'})`,
        { source: 'ble' }
      )
    }

    this.writeChar = pair.write
    this.notifyChar = pair.notify
    await delay(isJdy ? 80 : 50)
    if (typeof pair.notify.subscribeAsync === 'function') {
      await pair.notify.subscribeAsync()
      pair.notify.on('data', (data) => this.emit('data', Buffer.from(data)))
    } else {
      await this._subscribe(pair.notify)
    }

    peripheral.removeAllListeners('disconnect')
    peripheral.on('disconnect', (reason) => {
      this.emit('trace', `gatt disconnect ${reason != null ? reason : ''}`)
      this.writeChar = null
      this.notifyChar = null
      this.peripheral = null
      this.emit('close')
    })

    const name = advLocalName(peripheral.advertisement) || t.name || ''
    return {
      name,
      id: peripheral.id,
      address: peripheral.address,
      gatt: {
        service: pair.profile.service,
        write: uuid16(pair.write.uuid),
        notify: uuid16(pair.notify.uuid),
        writeProps: pair.write.properties,
        notifyProps: pair.notify.properties
      }
    }
  }

  write(buf) {
    if (!this.writeChar) {
      return Promise.reject(new DFirstJ2534Error('ble not connected', { source: 'ble' }))
    }
    const data = Buffer.from(buf)
    const props = this.writeChar.properties || []
    const withoutResponse = props.includes('writeWithoutResponse') || !props.includes('write')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new DFirstJ2534Error('ble gatt write timeout', { source: 'ble' })), 3000)
      try {
        this.writeChar.write(data, withoutResponse, (err) => {
          clearTimeout(timer)
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      } catch (err) {
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  async writeChunks(frame, chunk = this.chunk) {
    const size = Math.max(20, chunk)
    for (let i = 0; i < frame.length; i += size) {
      await this.write(frame.slice(i, i + size))
    }
  }

  async close() {
    await this._hardClose()
  }

  async _hardClose() {
    const p = this.peripheral
    this.writeChar = null
    this.notifyChar = null
    this.peripheral = null
    if (p) {
      await this._disconnectWait(p).catch(() => {})
    }
    await this._stopScan(this.noble)
  }

  _disconnectWait(peripheral) {
    if (!peripheral || peripheral.state === 'disconnected') {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000)
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      peripheral.once('disconnect', done)
      try {
        peripheral.disconnect()
      } catch (_) {
        done()
      }
    })
  }

  async _stopScan(noble) {
    if (!noble) {
      return
    }
    try {
      if (typeof noble.stopScanningAsync === 'function') {
        await Promise.race([noble.stopScanningAsync(), delay(1500)])
      } else {
        noble.stopScanning()
        await delay(150)
      }
    } catch (_) { /* not scanning */ }
  }

  _ready(noble) {
    const state = noble.state || noble._state
    if (state === 'poweredOn') {
      return Promise.resolve()
    }
    if (typeof noble.waitForPoweredOnAsync === 'function') {
      return noble.waitForPoweredOnAsync(8000)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new DFirstJ2534Error('bluetooth adapter not ready', { source: 'ble' })), 8000)
      noble.once('stateChange', (state) => {
        clearTimeout(timer)
        if (state === 'poweredOn') {
          resolve()
        } else {
          reject(new DFirstJ2534Error(`bluetooth ${state}`, { source: 'ble' }))
        }
      })
    })
  }

  _resolve(noble, target) {
    const id = typeof target === 'string' ? target : (target && (target.id || target.address || target.name))
    const prefix = (target && target.namePrefix) || this.options.namePrefix || BLE.NAME_PREFIX
    const timeout = (target && target.timeout) || this.options.timeout || 10000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        noble.removeListener('discover', onDiscover)
        this._stopScan(noble).finally(() => {
          reject(new DFirstJ2534Error(`ble device not found (${id || prefix})`, { source: 'ble' }))
        })
      }, timeout)
      const onDiscover = (p) => {
        const name = advLocalName(p.advertisement)
        const serviceHints = advServiceHints(p.advertisement)
        const ok = id
          ? p.id === id || p.address === id || name === id || (name && name.toUpperCase() === String(id).toUpperCase())
          : matchesScanFilter(name, serviceHints, prefix)
        if (!ok) {
          return
        }
        clearTimeout(timer)
        noble.removeListener('discover', onDiscover)
        this._stopScan(noble).finally(() => resolve(p))
      }
      noble.on('discover', onDiscover)
      const start = typeof noble.startScanningAsync === 'function'
        ? noble.startScanningAsync([], true)
        : Promise.resolve().then(() => noble.startScanning([], true))
      start.catch((err) => {
        clearTimeout(timer)
        noble.removeListener('discover', onDiscover)
        reject(err)
      })
    })
  }

  /**
   * WinRT：Connected 后异步建 GattSession。
   * JDY 空闲约 2s 会掉线：mtu 一到（或已有）立刻短 settle，马上 discover。
   * 不做软配对；不空等抬升 MTU。
   */
  async _waitGattReady(peripheral, isJdy, attempt = 0) {
    if (!peripheral) return
    const settleMs = isJdy ? 180 : 100
    this.emit('trace', 'wait GattSession/mtu…')

    let mtu = peripheral.mtu
    if (!mtu) {
      mtu = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(peripheral.mtu || null), isJdy ? 1500 : 1200)
        peripheral.once('mtu', (v) => {
          clearTimeout(timer)
          resolve(v)
        })
      })
    } else {
      // 已有 mtu：WinRT 里 MTU 回调早于 MaintainConnection，稍歇再挖
      await delay(isJdy ? 60 : 30)
    }

    this.emit('trace', `gatt session mtu=${mtu || peripheral.mtu || '?'} settle ${settleMs}ms`)
    await delay(settleMs)
    if (peripheral.state !== 'connected') {
      throw new DFirstJ2534Error('ble disconnected before discover', { source: 'ble' })
    }
  }

  /**
   * JDY：跳过 discoverSome（即便 ForUuid Uncached 也会踢断）。
   * 直接 FFE0/FFE1 绑特征；依赖 Windows GATT 缓存（设置里先配对一次最稳）。
   */
  async _discoverCharsJdy(peripheral, svcUuids, charUuids, attempt = 0) {
    if (peripheral.state !== 'connected') {
      throw new DFirstJ2534Error('ble disconnected before discover', { source: 'ble' })
    }
    try {
      this.emit('trace', 'jdy skip discover → uuid-direct FFE0/FFE1')
      const direct = await this._jdyBindUuidDirect(peripheral, svcUuids[0], charUuids[0])
      if (direct) return direct
    } catch (err) {
      this.emit('trace', `jdy uuid-direct fail: ${(err && err.message) || err}`)
      throw new DFirstJ2534Error(
        `JDY 需先建立 Windows GATT 缓存：请打开「设置 → 蓝牙和其他设备」添加该设备并完成配对，再回本页连接（${(err && err.message) || 'bind failed'}）`,
        { source: 'ble', cause: err }
      )
    }
    throw new DFirstJ2534Error(
      'JDY GATT 缓存为空：请先在 Windows「设置 → 蓝牙和其他设备」中添加/配对该设备，再回本页连接',
      { source: 'ble' }
    )
  }

  /**
   * 跳过 discover，按 FFE0/FFE1 注册 Characteristic，走 WinRT Cached ForUuid 读写/通知。
   * 需系统已有 GATT 缓存（通常来自 Windows 蓝牙配对）。
   */
  async _jdyBindUuidDirect(peripheral, serviceUuid, charUuid) {
    if (!peripheral || !peripheral._noble) return null
    const noble = peripheral._noble
    const svc = String(serviceUuid || 'ffe0').toLowerCase().replace(/-/g, '').slice(-4)
    const chr = String(charUuid || 'ffe1').toLowerCase().replace(/-/g, '').slice(-4)
    const nobleRoot = require('path').dirname(require.resolve('@stoprocent/noble'))
    const Service = require(require('path').join(nobleRoot, 'lib/service'))
    const Characteristic = require(require('path').join(nobleRoot, 'lib/characteristic'))

    if (!noble._services[peripheral.id]) noble._services[peripheral.id] = {}
    if (!noble._characteristics[peripheral.id]) noble._characteristics[peripheral.id] = {}
    if (!noble._characteristics[peripheral.id][svc]) noble._characteristics[peripheral.id][svc] = {}

    const service = new Service(noble, peripheral.id, svc)
    const characteristic = new Characteristic(
      noble,
      peripheral.id,
      svc,
      chr,
      ['read', 'write', 'writeWithoutResponse', 'notify']
    )
    noble._services[peripheral.id][svc] = service
    noble._characteristics[peripheral.id][svc][chr] = characteristic
    if (!peripheral.services) peripheral.services = []
    if (!peripheral.services.find((s) => uuid16(s.uuid) === svc)) {
      peripheral.services.push(service)
    }
    service.characteristics = [characteristic]

    this.emit('trace', `jdy uuid-direct subscribe ${svc}/${chr}`)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('jdy uuid-direct subscribe timeout')), 8000)
      characteristic.subscribe((err) => {
        clearTimeout(timer)
        if (err) reject(err)
        else resolve()
      })
    })
    // subscribe 成功说明 Cached ForUuid 命中
    return {
      services: [service],
      chars: [characteristic]
    }
  }

  async _discoverChars(peripheral, svcUuids, charUuids) {
    if (svcUuids.length && typeof peripheral.discoverSomeServicesAndCharacteristicsAsync === 'function') {
      this.emit('trace', `discoverSome ${svcUuids} / ${charUuids}`)
      const r = await peripheral.discoverSomeServicesAndCharacteristicsAsync(svcUuids, charUuids)
      return { services: r.services || [], chars: r.characteristics || [] }
    }
    if (typeof peripheral.discoverAllServicesAndCharacteristicsAsync === 'function') {
      this.emit('trace', 'discoverAll…')
      const r = await peripheral.discoverAllServicesAndCharacteristicsAsync()
      return { services: r.services || [], chars: r.characteristics || [] }
    }
    const r = await this._discover(peripheral)
    return { services: r.services || [], chars: r.chars || [] }
  }

  _connectPeripheral(peripheral) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new DFirstJ2534Error('ble connect timeout', { source: 'ble' })), 15000)
      if (peripheral.state === 'connected') {
        clearTimeout(timer)
        resolve()
        return
      }
      const finish = (err) => {
        clearTimeout(timer)
        if (err && /already connected/i.test(String(err.message || err))) {
          resolve()
        } else if (err) {
          reject(err)
        } else {
          resolve()
        }
      }
      try {
        if (typeof peripheral.connectAsync === 'function') {
          peripheral.connectAsync().then(() => finish(null), finish)
        } else {
          peripheral.connect(finish)
        }
      } catch (err) {
        finish(err)
      }
    })
  }

  _discover(peripheral) {
    const want = this.profile
      ? {
        services: [String(this.profile.service)],
        chars: [...new Set([this.profile.write, this.profile.notify].filter(Boolean).map(String))]
      }
      : null

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new DFirstJ2534Error('ble gatt discover timeout', { source: 'ble' })), 12000)
      const done = (err, services, chars) => {
        clearTimeout(timer)
        if (err) {
          reject(err)
        } else {
          resolve({ services: services || [], chars: chars || [] })
        }
      }

      // A0/A1 JDY：只挖 FFE0/FFE1，比 discoverAll 更不容易断连
      if (want && typeof peripheral.discoverSomeServicesAndCharacteristics === 'function') {
        peripheral.discoverSomeServicesAndCharacteristics(want.services, want.chars, (err, services, chars) => {
          if (!err && ((services && services.length) || (chars && chars.length))) {
            done(null, services, chars)
            return
          }
          peripheral.discoverAllServicesAndCharacteristics(done)
        })
        return
      }
      peripheral.discoverAllServicesAndCharacteristics(done)
    })
  }

  _pickChars({ services, chars }) {
    const skip = new Set(['1800', '1801', '180a'])
    const profiles = this.profile
      ? [this.profile, ...BLE.PROFILES]
      : BLE.PROFILES
    const allChars = []
    for (const s of services || []) {
      if (s.characteristics) allChars.push(...s.characteristics)
    }
    if (chars && chars.length) allChars.push(...chars)

    for (const prof of profiles) {
      const svc = (services || []).find((s) => uuid16(s.uuid) === uuid16(prof.service))
      const list = (svc && svc.characteristics && svc.characteristics.length)
        ? svc.characteristics
        : allChars.filter((c) => !svc || true)
      const scoped = svc
        ? (svc.characteristics && svc.characteristics.length ? svc.characteristics : allChars)
        : allChars.filter((c) => uuid16(c.uuid) === uuid16(prof.write) || uuid16(c.uuid) === uuid16(prof.notify))

      if (!svc && !scoped.length) continue

      const writeUuid = uuid16(prof.write)
      const notifyUuid = uuid16(prof.notify)
      const pool = scoped.length ? scoped : list

      // A0/A1：写/通知同一特征 FFE1 —— 属性表不全时也尝试订阅
      if (writeUuid === notifyUuid) {
        const both = pool.find((c) => uuid16(c.uuid) === writeUuid)
        if (both) {
          const props = both.properties || []
          const canWrite = !props.length || props.includes('write') || props.includes('writeWithoutResponse')
          if (canWrite) {
            return { write: both, notify: both, profile: prof }
          }
        }
      }
      const write = pool.find((c) => uuid16(c.uuid) === writeUuid
        && (!c.properties || !c.properties.length
          || c.properties.includes('write') || c.properties.includes('writeWithoutResponse')))
      const notify = pool.find((c) => uuid16(c.uuid) === notifyUuid
        && (!c.properties || !c.properties.length
          || c.properties.includes('notify') || c.properties.includes('indicate')))
      if (write && notify) {
        return { write, notify, profile: prof }
      }
      if (svc && write && !notify && writeUuid === notifyUuid) {
        return { write, notify: write, profile: prof }
      }
    }
    const usable = (services || []).filter((s) => !skip.has(uuid16(s.uuid)))
    for (const svc of usable) {
      const list = svc.characteristics || []
      const notify = list.find((c) => c.properties && (c.properties.includes('notify') || c.properties.includes('indicate')))
      const writeNr = list.find((c) => c.properties && c.properties.includes('writeWithoutResponse'))
      const write = writeNr || list.find((c) => c.properties && c.properties.includes('write'))
      if (write && notify) {
        return { write, notify, profile: { service: uuid16(svc.uuid) } }
      }
    }
    return null
  }

  _subscribe(char) {
    char.removeAllListeners('data')
    char.on('data', (data) => this.emit('data', Buffer.from(data)))
    return new Promise((resolve, reject) => {
      char.subscribe((err) => (err ? reject(err) : resolve()))
    })
  }
}

module.exports = { BleGatt, parseBlecfg, loadNoble }
