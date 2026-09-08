'use strict'

const { DFirstJ2534, PassThruChannel } = require('./device')
const { J2534Protocol } = require('./j2534')
const { BledlLink, inferBlecfg, BLECFG_BY_CODE, bleLinkSummary } = require('./bledl')
const { BleGatt } = require('./ble-gatt')
const { scanLan, lanIfaces } = require('./mdns')
const bledlCodec = require('./bledl-codec')
const { DFirstJ2534Error } = require('./errors')
const codec = require('./codec')
const constants = require('./constants')
const proVersion = require('./proVersion')

module.exports = {
  DFirstJ2534,
  PassThruChannel,
  J2534Protocol,
  BledlLink,
  BleGatt,
  scanLan,
  lanIfaces,
  DFirstJ2534Error,
  canId4: codec.canId4,
  canId5: codec.canId5,
  addr5: codec.addr5,
  ip4u32: codec.ip4u32,
  createCodec: codec.createCodec,
  encode: codec.encode,
  decode: codec.decode,
  codec,
  bledl: bledlCodec,
  inferBlecfg,
  BLECFG_BY_CODE,
  bleLinkSummary,
  ...proVersion,
  ...constants
}
