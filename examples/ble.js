'use strict'

const {
  DFirstJ2534,
  Protocol,
  ConnectFlag,
  TxFlag,
  FilterType,
  canId4,
  canId5,
  pinSelect
} = require('../src')

async function main() {
  const filter = process.argv[2] || 'QX'

  console.log('scanning BLE, prefix', filter)
  const found = await DFirstJ2534.scanBle({ namePrefix: filter, timeout: 8000 })
  if (!found.length) {
    console.error('no device (name starts with QX)')
    process.exit(1)
  }
  for (const d of found) {
    console.log(d.name, d.id, d.rssi)
  }

  const device = new DFirstJ2534({ transport: 'ble' })
  const info = await device.connect(found[0])
  console.log('connected', info)

  const { version } = await device.j2534.open()
  console.log('OPEN', version)

  const { channelId: canId } = await device.j2534.connect({
    connectFlags: ConnectFlag.CAN_ID_BOTH,
    protocolId: Protocol.CAN,
    baudRate: 500000,
    pinSelect: pinSelect(6, 14)
  })
  const { channelId: isoId } = await device.j2534.logicalConnect(canId, {
    protocolId: Protocol.ISO15765,
    connectFlags: ConnectFlag.ISO15765_FILTER,
    remoteTxFlags: TxFlag.ISO15765_PAD
  })
  await device.j2534.startMsgFilter(isoId, {
    type: FilterType.FLOW_CONTROL,
    mask: canId5(0x1FFFFFFF),
    pattern: canId5(0x7E8),
    flowControl: canId5(0x7E0),
    remoteTxFlags: TxFlag.ISO15765_PAD
  })
  await device.j2534.writeMsg(isoId, [{
    txFlags: TxFlag.ISO15765_PAD,
    data: Buffer.concat([canId4(0x7E0), Buffer.from('0100', 'hex')])
  }])
  const { messages } = await device.j2534.readMsg(isoId, { msgNum: 8, timeout: 1500 })
  for (const msg of messages) {
    console.log('rx', msg.data.toString('hex'))
  }

  await device.j2534.logicalDisconnect(isoId)
  await device.j2534.disconnect(canId)
  await device.j2534.close()
  await device.disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
