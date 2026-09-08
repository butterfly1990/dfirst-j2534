'use strict'

const os = require('os')
const dns = require('dns')
const { spawn, execFileSync } = require('child_process')
const { RDCOMM, BLE } = require('./constants')
const { DFirstJ2534Error } = require('./errors')

function loadMdns() {
  try {
    return require('multicast-dns')
  } catch {
    throw new DFirstJ2534Error('LAN mDNS needs multicast-dns (npm i multicast-dns / dfirst-j2534)', {
      source: 'mdns'
    })
  }
}

function isApipa(ip) {
  return String(ip || '').startsWith('169.254.')
}

function lanIfaces() {
  const list = []
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const v4 = a.family === 'IPv4' || a.family === 4
      if (v4 && !a.internal) {
        list.push({ name, address: a.address, apipa: isApipa(a.address) })
      }
    }
  }
  return list
}

function localV4() {
  return lanIfaces().map((x) => x.address)
}

/** Windows 上 169.254 网卡会抢走组播出口，查询发不进设备所在 Wi-Fi。 */
function pickScanIfaces(forced) {
  if (forced) {
    return [forced]
  }
  const all = lanIfaces()
  const good = all.filter((x) => !x.apipa)
  return (good.length ? good : all).map((x) => x.address)
}

function stripDot(name) {
  return String(name || '').replace(/\.$/, '')
}

function instanceName(fqdn) {
  const n = stripDot(fqdn)
  const i = n.indexOf('._rdcomm._tcp')
  if (i > 0) {
    return n.slice(0, i)
  }
  if (n.toLowerCase().endsWith('.local')) {
    return n.slice(0, -6)
  }
  return n.split('.')[0] || n
}

function parseTxt(data) {
  const txt = {}
  const items = Array.isArray(data) ? data : data != null ? [data] : []
  for (const item of items) {
    const s = Buffer.isBuffer(item) ? item.toString('utf8') : String(item)
    const eq = s.indexOf('=')
    if (eq > 0) {
      txt[s.slice(0, eq)] = s.slice(eq + 1)
    }
  }
  return txt
}

function recKey(name) {
  const inst = instanceName(name)
  return (inst || stripDot(name)).toLowerCase()
}

function upsert(map, key, patch) {
  const id = recKey(key)
  if (!id) {
    return
  }
  const cur = map.get(id) || {
    name: instanceName(key) || stripDot(key),
    host: '',
    port: RDCOMM.PORT,
    addresses: [],
    txt: {}
  }
  if (patch.name) {
    const inst = instanceName(patch.name)
    if (inst && !/_tcp/i.test(inst)) {
      cur.name = inst
    }
  }
  if (patch.host) {
    cur.host = stripDot(patch.host)
  }
  if (patch.port) {
    cur.port = patch.port
  }
  if (patch.txt) {
    cur.txt = { ...cur.txt, ...patch.txt }
  }
  if (patch.addresses) {
    const set = new Set(cur.addresses)
    for (const ip of patch.addresses) {
      if (ip) {
        set.add(ip)
      }
    }
    cur.addresses = [...set]
  }
  map.set(id, cur)
}

function attachA(map, hostname, ip) {
  if (!ip || String(ip).includes(':')) {
    return
  }
  const host = stripDot(hostname).toLowerCase()
  const inst = instanceName(hostname).toLowerCase()
  for (const [key, rec] of map) {
    const recHost = stripDot(rec.host).toLowerCase()
    const recInst = instanceName(rec.name || rec.host).toLowerCase()
    if (key === inst || recHost === host || recInst === inst) {
      upsert(map, key, { addresses: [ip] })
    }
  }
}

function isRdcomm(name) {
  return /_rdcomm\._tcp/i.test(stripDot(name || ''))
}

function ingest(map, packet) {
  const recs = [...(packet.answers || []), ...(packet.additionals || [])]
  for (const rec of recs) {
    if (rec.type === 'PTR' && isRdcomm(rec.name) && rec.data) {
      upsert(map, rec.data, { name: rec.data })
    }
  }
  for (const rec of recs) {
    if (rec.type === 'SRV' && rec.data && (isRdcomm(rec.name) || map.has(recKey(rec.name)))) {
      upsert(map, rec.name, {
        name: rec.name,
        host: rec.data.target,
        port: rec.data.port
      })
    } else if (rec.type === 'TXT' && (isRdcomm(rec.name) || map.has(recKey(rec.name)))) {
      upsert(map, rec.name, { name: rec.name, txt: parseTxt(rec.data) })
    } else if (rec.type === 'A') {
      attachA(map, rec.name, rec.data)
    }
  }
}

function toPublicList(map) {
  const seen = new Set()
  const list = []
  for (const rec of map.values()) {
    const inst = instanceName(rec.name || rec.host)
    if (!inst || !/^QX/i.test(inst) || /_tcp/i.test(inst)) {
      continue
    }
    const ips = rec.addresses.filter((ip) => ip && !String(ip).includes(':'))
    const uniqueIps = [...new Set(ips.length ? ips : rec.host && !String(rec.host).includes(':') ? [rec.host] : [])]
    const psn = inst.startsWith(BLE.NAME_PREFIX) ? inst.slice(BLE.NAME_PREFIX.length) : inst
    for (const ip of uniqueIps) {
      if (seen.has(ip)) {
        continue
      }
      seen.add(ip)
      list.push({
        id: ip,
        name: inst,
        host: ip,
        port: rec.port || RDCOMM.PORT,
        hostname: rec.host,
        addresses: uniqueIps,
        txt: rec.txt,
        psn,
        transport: 'lan'
      })
    }
  }
  return list
}

function openBrowser(multicastDns, iface) {
  return new Promise((resolve, reject) => {
    const opts = { port: 5353, reuseAddr: true }
    if (iface) {
      opts.interface = iface
    }
    const mdns = multicastDns(opts)
    const timer = setTimeout(() => {
      mdns.removeListener('error', onError)
      resolve(mdns)
    }, 400)
    const onError = (err) => {
      clearTimeout(timer)
      try {
        mdns.destroy()
      } catch {
        /* ignore */
      }
      reject(new DFirstJ2534Error(
        'mDNS 无法绑定 UDP 5353: ' + err.message + '。可手动填 IP，或关掉占用 5353 的程序后再扫',
        { source: 'mdns' }
      ))
    }
    mdns.once('error', onError)
    mdns.once('ready', () => {
      clearTimeout(timer)
      mdns.removeListener('error', onError)
      mdns.on('error', () => {})
      resolve(mdns)
    })
  })
}

async function openBrowsers(multicastDns, ifaces) {
  const browsers = []
  for (const ip of ifaces) {
    try {
      browsers.push(await openBrowser(multicastDns, ip))
    } catch {
      /* 该网卡绑定失败则跳过 */
    }
  }
  if (!browsers.length) {
    browsers.push(await openBrowser(multicastDns))
  }
  return browsers
}

function askBrowse(mdns, type, hostQuery) {
  mdns.query({ questions: [{ name: type, type: 'PTR' }] })
  if (hostQuery) {
    mdns.query({ questions: [{ name: hostQuery, type: 'A' }] })
  }
}

/** PTR 先到、SRV/A 后到时补问，否则列表只有名字没有 IP。 */
function askMissing(mdns, map) {
  for (const rec of map.values()) {
    const inst = instanceName(rec.name || rec.host)
    if (!inst || /_tcp/i.test(inst)) {
      continue
    }
    const fqdn = `${inst}._rdcomm._tcp.local`
    if (!rec.host || !rec.port) {
      mdns.query({ questions: [{ name: fqdn, type: 'SRV' }] })
    }
    const host = rec.host && !/^\d+\.\d+\.\d+\.\d+$/.test(rec.host)
      ? (String(rec.host).toLowerCase().endsWith('.local') ? rec.host : `${rec.host}.local`)
      : `${inst}.local`
    if (!rec.addresses.length) {
      mdns.query({ questions: [{ name: host, type: 'A' }] })
    }
  }
}

async function scanLanRaw(opts = {}) {
  const timeout = opts.timeout != null ? Number(opts.timeout) : 8000
  const multicastDns = loadMdns()
  const type = RDCOMM.MDNS_TYPE
  const hostQuery = opts.name
    ? (String(opts.name).toLowerCase().endsWith('.local')
      ? opts.name
      : `${opts.name}.local`)
    : null

  const browsers = await openBrowsers(multicastDns, pickScanIfaces(opts.interface))
  const map = new Map()

  const onPacket = (packet) => {
    try {
      ingest(map, packet)
    } catch {
      /* ignore malformed */
    }
  }
  for (const mdns of browsers) {
    mdns.on('response', onPacket)
  }

  const started = Date.now()
  for (const mdns of browsers) {
    askBrowse(mdns, type, hostQuery)
  }
  const retries = [800, 2000, 4000, 6000].filter((t) => t < timeout)
  await new Promise((resolve) => {
    const timers = retries.map((t) => setTimeout(() => {
      for (const mdns of browsers) {
        askBrowse(mdns, type, hostQuery)
        askMissing(mdns, map)
      }
    }, t))
    setTimeout(() => {
      for (const id of timers) clearTimeout(id)
      resolve()
    }, Math.max(400, timeout - (Date.now() - started)))
  })
  for (const mdns of browsers) {
    try {
      mdns.destroy()
    } catch {
      /* ignore */
    }
  }

  return map
}

let dnsSdAvailable = null

function hasDnsSd() {
  if (dnsSdAvailable != null) return dnsSdAvailable
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    dnsSdAvailable = false
    return false
  }
  try {
    if (process.platform === 'win32') {
      execFileSync('where.exe', ['dns-sd'], { stdio: 'ignore', windowsHide: true })
    } else {
      execFileSync('which', ['dns-sd'], { stdio: 'ignore' })
    }
    dnsSdAvailable = true
  } catch {
    dnsSdAvailable = false
  }
  return dnsSdAvailable
}

function killSpawned(proc) {
  if (!proc || !proc.pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
    } catch {
      /* ignore */
    }
  } else {
    try {
      proc.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
}

function runDnsSd(args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const done = (out) => {
      if (settled) return
      settled = true
      resolve(out || '')
    }
    let proc
    try {
      proc = spawn('dns-sd', args, { windowsHide: true })
    } catch {
      done('')
      return
    }
    let out = ''
    proc.stdout.on('data', (d) => { out += d.toString() })
    proc.stderr.on('data', (d) => { out += d.toString() })
    proc.on('error', () => done(out))
    proc.on('close', () => done(out))
    setTimeout(() => {
      killSpawned(proc)
      setTimeout(() => done(out), 80)
    }, timeoutMs)
  })
}

function parseDnsSdBrowse(out) {
  const names = new Set()
  for (const line of String(out || '').split(/\r?\n/)) {
    if (!/\bAdd\b/i.test(line)) continue
    const parts = line.trim().split(/\s+/)
    const idx = parts.findIndex((p) => /_rdcomm\._tcp/i.test(p))
    if (idx >= 0 && parts[idx + 1]) {
      const inst = parts[idx + 1].replace(/\.$/, '')
      if (inst && /^QX/i.test(inst)) names.add(inst)
    }
  }
  return [...names]
}

function parseDnsSdLookup(out) {
  const m = String(out || '').match(/can be reached at\s+(\S+?):(\d+)/i)
  if (!m) return null
  const host = stripDot(m[1])
  const port = Number(m[2]) || RDCOMM.PORT
  const txt = {}
  for (const kv of String(out).matchAll(/\b([A-Za-z][A-Za-z0-9_]*)=([^\s"]+)/g)) {
    txt[kv[1]] = kv[2]
  }
  return { host, port, txt }
}

function parseDnsSdAddresses(out) {
  const ips = []
  for (const line of String(out || '').split(/\r?\n/)) {
    if (!/\bAdd\b/i.test(line)) continue
    const m = line.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/)
    if (m && !isApipa(m[1])) ips.push(m[1])
  }
  return [...new Set(ips)]
}

function lookupLocal(hostname) {
  const host = stripDot(hostname)
  const name = /\.local$/i.test(host) ? host : `${host}.local`
  return new Promise((resolve) => {
    dns.lookup(name, { family: 4 }, (err, address) => {
      if (err || !address || isApipa(address)) resolve(null)
      else resolve(address)
    })
  })
}

async function resolveDnsSdInstance(name, budgetMs) {
  const slice = Math.max(1200, Math.floor(budgetMs / 2))
  const look = await runDnsSd(['-L', name, '_rdcomm._tcp', 'local.'], slice)
  const srv = parseDnsSdLookup(look)
  const hostLocal = (srv && srv.host) || `${name}.local`
  const aOut = await runDnsSd(
    ['-G', 'v4', /\.local$/i.test(hostLocal) ? hostLocal : `${hostLocal}.local`],
    slice
  )
  let ips = parseDnsSdAddresses(aOut)
  if (!ips.length) {
    const viaOs = await lookupLocal(hostLocal)
    if (viaOs) ips = [viaOs]
  }
  if (!ips.length) {
    const viaOs2 = await lookupLocal(`${name}.local`)
    if (viaOs2) ips = [viaOs2]
  }
  return {
    name,
    host: (srv && srv.host) || `${name}.local`,
    port: (srv && srv.port) || RDCOMM.PORT,
    addresses: ips,
    txt: (srv && srv.txt) || {}
  }
}

/**
 * Windows/macOS：Bonjour 占用 5353 时，自建 multicast-dns 常漏设备。
 * 用系统 dns-sd 浏览（与 Bonjour Browser 同源）。
 */
async function scanLanDnsSd(opts = {}) {
  if (!hasDnsSd()) return new Map()
  const timeout = opts.timeout != null ? Number(opts.timeout) : 8000
  const browseMs = Math.max(3500, Math.min(timeout - 1500, Math.floor(timeout * 0.65)))
  const browseOut = await runDnsSd(['-B', '_rdcomm._tcp', 'local.'], browseMs)
  let names = parseDnsSdBrowse(browseOut)
  if (opts.name) {
    const want = instanceName(opts.name)
    if (want && !names.includes(want)) names = names.concat([want])
  }
  const map = new Map()
  const left = Math.max(2000, timeout - browseMs)
  const per = Math.max(2000, Math.floor(left / Math.max(1, names.length)))
  await Promise.all(names.map(async (name) => {
    try {
      const rec = await resolveDnsSdInstance(name, per)
      upsert(map, name, {
        name,
        host: rec.host,
        port: rec.port,
        addresses: rec.addresses,
        txt: rec.txt
      })
    } catch {
      upsert(map, name, { name })
    }
  }))
  return map
}

async function fillMissingAddresses(map) {
  const jobs = []
  for (const rec of map.values()) {
    if (rec.addresses && rec.addresses.length) continue
    const inst = instanceName(rec.name || rec.host)
    if (!inst || !/^QX/i.test(inst)) continue
    const host = rec.host || `${inst}.local`
    jobs.push((async () => {
      const ip = await lookupLocal(host)
      if (ip) upsert(map, inst, { addresses: [ip] })
    })())
  }
  if (jobs.length) await Promise.all(jobs)
}

function mergeMaps(into, from) {
  for (const [, rec] of from) {
    upsert(into, rec.name || rec.host, {
      name: rec.name,
      host: rec.host,
      port: rec.port,
      addresses: rec.addresses,
      txt: rec.txt
    })
  }
}

/**
 * Browse DNS-SD `_rdcomm._tcp.local` (same records Bonjour would see).
 * Optionally also query `{name}.local` A if PSN / BLE name is known.
 * @param {{timeout?: number, name?: string, interface?: string}} opts
 */
async function scanLan(opts = {}) {
  const timeout = opts.timeout != null ? Number(opts.timeout) : 8000
  const map = new Map()

  // Windows 装了 Bonjour 时，自建 UDP 5353 常漏设备；与 Bonjour Browser 一样走 dns-sd
  if (hasDnsSd()) {
    mergeMaps(map, await scanLanDnsSd({ ...opts, timeout }))
    await fillMissingAddresses(map)
    const missingIp = [...map.values()].some((r) => !(r.addresses && r.addresses.length))
    if (map.size === 0 || missingIp) {
      mergeMaps(map, await scanLanRaw({ ...opts, timeout: Math.min(4000, timeout) }))
      await fillMissingAddresses(map)
    }
  } else {
    mergeMaps(map, await scanLanRaw({ ...opts, timeout }))
    await fillMissingAddresses(map)
  }

  return toPublicList(map)
}

module.exports = { scanLan, localV4, lanIfaces }
