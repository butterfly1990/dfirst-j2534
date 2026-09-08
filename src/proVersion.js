'use strict'

/** 与 Activer `V2Device` 对齐：走 J2534_RD（V2 小端 u32）。其余 A0–A4 等为 V1。 */
const V2_DEVICE_CODES = Object.freeze(['A5', 'A6', 'C0', 'S0', 'S1', 'S2', 'D0'])
const V1_DEVICE_CODES = Object.freeze(['A0', 'A1', 'A2', 'A3', 'A4', 'B0'])

/**
 * 从 BLE 名 / PSN / mDNS 实例名解析机型码（A0–A6、S0–S2、C0、D0…）。
 * @param {string} [nameOrPsn]
 * @returns {string} 如 `S2`，无法识别则 `''`
 */
function deviceCodeFromName(nameOrPsn) {
  const s = String(nameOrPsn || '')
  const m = s.match(/(?:QX[-_]?)?(A[0-6]|S[012]|C0|B0|D0)/i)
  return m ? m[1].toUpperCase() : ''
}

function normalizeProVersion(v) {
  const s = String(v || '').trim().toUpperCase()
  if (s === 'V1' || s === '1' || s === '') return s === '' ? '' : 'V1'
  if (s.startsWith('V2') || s === '2') return 'V2'
  return s.startsWith('V') ? s.slice(0, 2) : s
}

/**
 * OPEN / READ_VERSION 字符串：`soft,hard,sn,boot[,V2]`
 * @returns {{ soft?: string, hard?: string, sn?: string, boot?: string, proVersion?: string, raw: string }}
 */
function parseOpenVersionString(versionStr) {
  const raw = String(versionStr || '').replace(/\0+$/g, '').trim()
  const parts = raw.split(',')
  const out = { raw }
  if (parts.length >= 1 && parts[0]) out.soft = parts[0]
  if (parts.length >= 2) out.hard = parts[1]
  if (parts.length >= 3) out.sn = parts[2]
  if (parts.length >= 4) out.boot = parts[3]
  if (parts.length >= 5 && parts[4]) {
    const pv = normalizeProVersion(parts[4])
    if (pv) out.proVersion = pv
  }
  return out
}

/**
 * 按机型推断协议版本。未知机型默认 V2（与当前 S 系列 SDK 一致）；可用 override 强制。
 * @param {{ name?: string, psn?: string, deviceCode?: string, openVersion?: string, override?: string }} opts
 * @returns {'V1'|'V2'}
 */
function inferProVersion(opts = {}) {
  const override = normalizeProVersion(opts.override)
  if (override === 'V1' || override === 'V2') return override

  const fromOpen = parseOpenVersionString(opts.openVersion).proVersion
  if (fromOpen === 'V1' || fromOpen === 'V2') return fromOpen

  const code = (opts.deviceCode || deviceCodeFromName(opts.name || opts.psn) || '').toUpperCase()
  if (V2_DEVICE_CODES.includes(code)) return 'V2'
  if (V1_DEVICE_CODES.includes(code)) return 'V1'
  return 'V2'
}

/** Activer `_getVersionList`：优先猜的版本，失败再试另一套。 */
function openVersionTryOrder(preferred) {
  const p = normalizeProVersion(preferred) === 'V1' ? 'V1' : 'V2'
  return p === 'V2' ? ['V2', 'V1'] : ['V1', 'V2']
}

function isV2DeviceCode(code) {
  return V2_DEVICE_CODES.includes(String(code || '').toUpperCase())
}

module.exports = {
  V2_DEVICE_CODES,
  V1_DEVICE_CODES,
  deviceCodeFromName,
  normalizeProVersion,
  parseOpenVersionString,
  inferProVersion,
  openVersionTryOrder,
  isV2DeviceCode
}
