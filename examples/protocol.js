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
  const host = process.argv[2]
  if (!host) {
    console.error('Usage: node examples/protocol.js <device-e0-ip>')
    process.exit(1)
  }

  const device = new DFirstJ2534({ host })
  await device.connect()
  console.log('register', device.info)

  const { version } = await device.j2534.open()
  console.log('OPEN', version)

  const { channelId: canId } = await device.j2534.connect({
    connectFlags: ConnectFlag.CAN_ID_BOTH,
    protocolId: Protocol.CAN,
    baudRate: 500000,
    pinSelect: pinSelect(6, 14)
  })
  console.log('CONNECT', canId)

  const { channelId: isoId } = await device.j2534.logicalConnect(canId, {
    protocolId: Protocol.ISO15765,
    connectFlags: ConnectFlag.ISO15765_FILTER,
    remoteTxFlags: TxFlag.ISO15765_PAD
  })
  console.log('LOGICALCONNECT', isoId)

  const { id: filterId } = await device.j2534.startMsgFilter(isoId, {
    type: FilterType.FLOW_CONTROL,
    mask: canId5(0x1FFFFFFF),
    pattern: canId5(0x7E8),
    flowControl: canId5(0x7E0),
    remoteTxFlags: TxFlag.ISO15765_PAD
  })
  console.log('STARTMSGFILTER', filterId)

  const written = await device.j2534.writeMsg(isoId, [{
    txFlags: TxFlag.ISO15765_PAD,
    data: Buffer.concat([canId4(0x7E0), Buffer.from('0100', 'hex')])
  }])
  console.log('WRITEMSG', written.msgNum)

  const { messages } = await device.j2534.readMsg(isoId, { msgNum: 8, timeout: 1500 })
  for (const msg of messages) {
    console.log('READMSG', msg.rxStatus.toString(16), msg.data.toString('hex'))
  }

  await device.j2534.stopMsgFilter(isoId, filterId)
  await device.j2534.logicalDisconnect(isoId)
  await device.j2534.disconnect(canId)
  await device.j2534.close()
  await device.disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
