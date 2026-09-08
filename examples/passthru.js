'use strict'

const {
  DFirstJ2534,
  Protocol,
  ConnectFlag,
  TxFlag,
  FilterType,
  Ioctl,
  canId4,
  canId5,
  pinSelect
} = require('../src')

async function main() {
  const host = process.argv[2]
  if (!host) {
    console.error('Usage: node examples/passthru.js <device-e0-ip>')
    process.exit(1)
  }

  const device = new DFirstJ2534({ host })
  await device.connect()
  console.log(device.info)

  const mv = await device.readPinVoltage(16)
  console.log('pin16', mv, 'mV')

  await device.passThruOpen()
  console.log('version', await device.passThruReadVersion())

  const can = await device.passThruConnect({
    protocol: Protocol.CAN,
    baud: 500000,
    flags: ConnectFlag.CAN_ID_BOTH,
    pinSelect: pinSelect(6, 14)
  })
  console.log('CAN channel', can.id)

  const iso = await can.connectLogical({
    protocol: Protocol.ISO15765,
    flags: ConnectFlag.ISO15765_FILTER,
    remoteTxFlags: TxFlag.ISO15765_PAD
  })
  console.log('ISO15765 channel', iso.id)

  await iso.startMsgFilter({
    type: FilterType.FLOW_CONTROL,
    mask: canId5(0x1FFFFFFF),
    pattern: canId5(0x7E8),
    flowControl: canId5(0x7E0),
    remoteTxFlags: TxFlag.ISO15765_PAD
  })

  await iso.writeMsgs([{
    txFlags: TxFlag.ISO15765_PAD,
    data: Buffer.concat([canId4(0x7E0), Buffer.from('0100', 'hex')])
  }])

  const msgs = await iso.readMsgs({ num: 8, timeout: 1500 })
  for (const msg of msgs) {
    console.log('rx', msg.rxStatus.toString(16), msg.data.toString('hex'))
  }

  await iso.ioctl(Ioctl.CLEAR_RX_QUEUE)
  await iso.disconnect()
  await can.disconnect()
  await device.passThruClose()
  await device.disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
