'use strict'

const {
  DFirstJ2534,
  ConnectFlag,
  TxFlag
} = require('../src')

async function main() {
  const host = process.argv[2]
  if (!host) {
    console.error('Usage: node examples/iso15765-uds.js <device-e0-ip>')
    process.exit(1)
  }

  const device = new DFirstJ2534({ host })
  device.on('error', (err) => console.error(err.message))

  const info = await device.connect()
  console.log('device', info)

  const iso = await device.openIso15765({
    baud: 500000,
    flags: ConnectFlag.CAN_ID_BOTH,
    txId: 0x7E0,
    rxId: 0x7E8,
    txFlags: TxFlag.ISO15765_PAD
  })
  console.log('ISO15765 channel', iso.id)

  const pid00 = await iso.request('0100')
  console.log('0100', pid00.data.toString('hex'))

  try {
    const vin = await iso.request('22F190')
    console.log('22F190', vin.data.toString('hex'), vin.data.slice(3).toString('ascii'))
  } catch (err) {
    console.error('UDS VIN failed:', err.message)
  }

  await iso.disconnect()
  await iso.physicalChannel.disconnect()
  await device.disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
