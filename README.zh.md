# dfirst-j2534

English: [README.md](README.md) · [PROTOCOL.en.md](PROTOCOL.en.md) · [PROTOCOL.md](PROTOCOL.md)

面向 **QX DFirst** 设备的 Node **J2534 DIY SDK**（npm：`dfirst-j2534`，类名 `DFirstJ2534`）。接口按 DFirst 固件命令字自研封装，**不是**通用 OBD / ELM327 库。

## 适用范围与主机链路

| 机型 | BLE | LAN（有线 e0 / Wi‑Fi w0） |
|------|-----|---------------------------|
| **QX-A** 系列（A0–A6） | ✅ | — |
| **QX Slink**（S0 / S1 / **S2**） | ✅ | ✅ |
| **ELM327** 及同类 AT 指令适配器 | ❌ 暂不支持 | ❌ |

**别名（文档 / 产品名）：**

| 名称 | 含义 |
|------|------|
| **QXS2** | **QX Slink WiFi**（Slink 系列；亦可 BLE） |
| **ETH**（ProtocolID `0xFD`） | **DoIP** 物理以太网承载；其上逻辑通道常用 **ISO13400**（DoIP） |

命令字与通道细节见 [PROTOCOL.md](PROTOCOL.md)。

链路二选一：

| 传输 | 封装 | 连接 |
|------|------|------|
| LAN | RDComm TCP 19000 | `{ host: 'e0 IP' }` |
| BLE | BLEDL（3 字节头 / 压缩 / CRC / ACK） | `{ transport: 'ble' }` |

J2534 编解码共用。BLE 上**没有** RDComm，GATT 解完就是命令字。

## 各机型支持的协议

主机链路：**QX-A 仅 BLE**；**QX Slink（S0/S1/S2）支持 BLE + LAN**。下列为各机可 CONNECT 的物理协议，以及其上可开的逻辑协议（与固件 / 测试页一致）。CAN-FD 表示该机 CAN 类物理支持 FD 数据相位（`SET_CONFIG`），不是单独 ProtocolID。

### QX-A0 / QX-A1
- 主机：BLE
- 物理：CAN
- 逻辑（在 CAN 上）：ISO15765、ISO15765 过滤通道、TP20、TP16

### QX-A2
- 主机：BLE
- 物理：CAN、MSCAN、ETH（DoIP）
- 逻辑：在 CAN / MSCAN 上 → ISO15765、ISO15765 过滤通道、TP20、TP16；在 ETH（DoIP）上 → ISO13400（DoIP）、ETH_BMW、ETH_PASSTHRU

### QX-A3
- 主机：BLE
- 物理：CAN、MSCAN
- 逻辑（在 CAN / MSCAN 上）：ISO15765、ISO15765 过滤通道、TP20、TP16

### QX-A4
- 主机：BLE
- 物理：CAN、MSCAN、SWCAN、ETH（DoIP）；CAN 类支持 CAN-FD
- 逻辑：在 CAN / MSCAN / SWCAN 上 → ISO15765、ISO15765 过滤通道、TP20、TP16；在 ETH（DoIP）上 → ISO13400（DoIP）、ETH_BMW、ETH_PASSTHRU

### QX-A5 / QX-A6
- 主机：BLE
- 物理：CAN、MSCAN、LSCAN、CAN1/9、CAN12/13、ISO14230、ISO9141、J1850VPW、J1850PWM；CAN 类支持 CAN-FD
- 逻辑：在 CAN / MSCAN / LSCAN / CAN1/9 / CAN12/13 上 → ISO15765、ISO15765 过滤通道、TP20、TP16；K 线 / J1850 无逻辑通道（物理上直接收发）

### QXS0
- 主机：BLE、LAN
- 物理：CAN、MSCAN、SWCAN、LSCAN、CAN12/13、ETH（DoIP）、ISO14230、ISO9141；CAN 类支持 CAN-FD
- 逻辑：在 CAN 类上 → ISO15765、ISO15765 过滤通道、TP20、TP16；在 ETH（DoIP）上 → ISO13400（DoIP）、ETH_BMW、ETH_PASSTHRU；K 线无逻辑通道

### QXS1
- 主机：BLE、LAN；可 BLE 配 Wi‑Fi STA 后切 LAN
- 物理：CAN、MSCAN、SWCAN、LSCAN、CAN12/13、ETH（DoIP）、ISO14230、ISO9141、J1850VPW、J1850PWM；CAN 类支持 CAN-FD
- 逻辑：在 CAN 类上 → ISO15765、ISO15765 过滤通道、TP20、TP16；在 ETH（DoIP）上 → ISO13400（DoIP）、ETH_BMW、ETH_PASSTHRU；K 线 / J1850 无逻辑通道

### QXS2（QX Slink WiFi）
- 主机：BLE、LAN；可 BLE 配 Wi‑Fi STA 后切 LAN
- 物理：CAN、MSCAN、SWCAN、LSCAN、CAN12/13、ETH（DoIP）、ISO14230、ISO9141、J1850VPW、J1850PWM；CAN 类支持 CAN-FD
- 逻辑：在 CAN 类上 → ISO15765、ISO15765 过滤通道、TP20、TP16；在 ETH（DoIP）上 → ISO13400（DoIP）、ETH_BMW、ETH_PASSTHRU；K 线 / J1850 无逻辑通道

## 安装

```bash
npm i dfirst-j2534
# BLE（可选）：npm i @stoprocent/noble   # Windows
#             npm i @abandonware/noble  # Linux/macOS
```

源码目录开发：

```bash
cd Tools/node-DFirstJ2534
npm install
```

```js
const { DFirstJ2534 } = require('dfirst-j2534')
```

## 连接

设备在 **e0** 和 **w0** 上发 DNS-SD：`QX{PSN}._rdcomm._tcp.local`，端口 **19000**，主机名 `QX{PSN}.local`。不需要装 Apple Bonjour；SDK 直接发 mDNS 组播查询。已知 PSN 时也可 `scanLan({ name: 'QXS226…' })` 查 A 记录。仍可手写 `{ host: '192.168.1.50' }`。

BLE（广播名 `QX` / `QX-A…`）。先装适配器：`npm i @stoprocent/noble`（Windows）或 `@abandonware/noble`。

```js
const found = await DFirstJ2534.scanBle({ namePrefix: 'QX', timeout: 12000 })
const device = new DFirstJ2534({ transport: 'ble' }) // 也可传 blecfg
await device.connect(found[0])
```

| 机型 | J2534 | blecfg（可自动） | BLE 分包 |
|------|-------|------------------|----------|
| A0 / A1 / B0 | V1 | `FFE0-FFE1-FFE1-FFE1-14-20` | **JDY**（≤20B + 序号头） |
| A2 / A3 / A4 | V1 | `FFE1-FFE3-FFE1-FFE2-200-D4` | MTU−12 切片（无序号头） |
| A5 / A6 | V2 | `FFE1-FFE3-FFE1-FFE2-2000-D4` | 同上 |
| C0 | V2 | `FEE0-FEE1-FEE2-FEE2-200-C0` | 同上 |
| S0 / S1 / S2 | V2 | （默认 A002 配置） | ESP32 AT |

GATT 默认按上表/`PROFILES` 试 UUID。对不上可手动 `blecfg`。

`device.j2534.*` 与传输无关。

QXS1 / QXS2 可用 BLE 配 WiFi（ESP32 STA）：

```js
const aps = await device.wifiScan()           // CUSTOM_FEATURE 0x18
const st = await device.wifiGetState()        // 0x15  → { state, ssid, label }
await device.wifiConnect('MyAP', 'password')  // 0x16
await device.wifiDisconnect()                 // 0x17
```

连上后设备在 **w0** 发 `_rdcomm._tcp`，可切 LAN。

## 协议接口 `device.j2534`

和命令字表一一对应，返回 `{ error, ... }`：

```js
const {
  DFirstJ2534, Protocol, ConnectFlag, TxFlag, FilterType, Ioctl,
  canId4, canId5, pinSelect
} = require('./src')

await device.j2534.open()                    // 0x01 OPEN
const { version } = await device.j2534.readVersion()

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

const { id: filterId } = await device.j2534.startMsgFilter(isoId, {
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

const { messages } = await device.j2534.readMsg(isoId, { msgNum: 8, timeout: 1000 })

await device.j2534.logicalDisconnect(isoId)
await device.j2534.disconnect(canId)
await device.j2534.close()
```

| 方法 | 命令字 | 请求参数 | 应答 |
|------|--------|----------|------|
| `open` | `0x01` | 无 | `{ error, version }` |
| `close` | `0x02` | 无 | `{ error }` |
| `connect` | `0x03` | `connectFlags`, `protocolId`, `baudRate`, `pinSelect` | `{ error, channelId }` |
| `disconnect` | `0x04` | `channelId` | `{ error, channelId }` |
| `readMsg` | `0x05` | `{ msgNum=8, timeout=1000 }` | `{ error, messages[] }` 每条含 `rxStatus`, `data`, `extraDataIndex` |
| `writeMsg` | `0x06` | `[{ handle, txFlags, data }]` | `{ error, msgNum }` |
| `startPeriodicMsg` | `0x07` | `{ interval, handle, txFlags, data }` | `{ error, msgId }` |
| `stopPeriodicMsg` | `0x08` | `msgId` | `{ error }` |
| `startMsgFilter` | `0x09` | `{ type, localTxFlags, remoteTxFlags, mask, pattern, exp, argument\|flowControl }` | `{ error, id: filterId }` |
| `stopMsgFilter` | `0x0A` | `filterId` | `{ error }` |
| `readVersion` | `0x0C` | 无 | `{ error, version }` |
| `ioctl` | `0x0D` | `(channelId, ioctlId, inputBuf)` | `{ error, output }` |
| `logicalConnect` | `0x0E` | 见下表 | `{ error, channelId, logicalChannelId }` |
| `logicalDisconnect` | `0x0F` | `channelId` | `{ error }` |
| `customFeature` | `0x10` | `(featureId, inputBuf)` | `{ error, output? }` |
| `exec` | 任意 | 已编码 Buffer | `{ error, raw }` |

### `connect` / `logicalConnect` 参数

| 参数 | CONNECT（物理） | LOGICALCONNECT |
|------|-----------------|----------------|
| `protocolId` | CAN=5, ETH=0xFD, ISO9141=3… | ISO15765=0x200, TP20=0x300, ISO13400=0x400… |
| `connectFlags` | CAN 常用 `CAN_ID_BOTH`；ETH 见 DHCP/AUTO_IP | 点对点 0 或 MINI；过滤加 `ISO15765_FILTER` |
| `baudRate` | CAN 500000；K 线 10400 | （继承物理） |
| `pinSelect` | `pinSelect(6,14)`→`0x060E`；0=默认 | — |
| `localTxFlags` / `remoteTxFlags` | — | 填充/混合/29 位；ETH 时由 IP/Port 占用 |
| `localAddress` / `remoteAddress` | — | 5 字节地址；或 SDK `canId5`/`addr5` |
| `remoteIP` / `remotePort` / `localPort` | — | 仅 ETH 逻辑 |

### `readMsg` / `writeMsg` 要点

- **读**：`timeout` 为毫秒；`TIMEOUT`/`BUFFER_EMPTY` 时 `messages` 仍可能非空。跳过 `TX_*` 与空 `START_OF_MESSAGE`，取带 UDS 的帧。
- **写**：ISO15765 `data` = `canId4(txId)[+1 字节 EA] + UDS`；`txFlags` 与逻辑通道 Remote 一致（填充/混合）。

### `startMsgFilter` 要点

| `type` | 通道 | 说明 |
|--------|------|------|
| PASS=1 / BLOCK=2 | 物理 CAN | Mask/Pattern 验收或丢弃 |
| FLOW_CONTROL=3 | ISO15765 逻辑 | Pattern=RX；`exp`+`argument` 算 TX |

`argument` 与 `flowControl` 同义（5 字节）。Exp 见 PROTOCOL 过滤表。

ISO15765 的 `data` 前 4 字节是大端 CAN ID，后面才是 UDS。参数细节与线格式见 [PROTOCOL.md](PROTOCOL.md)。

编解码也可直接用：`encode.connect(...)`、`decode.readMsg(buf)`。

## 快捷方法

仍可用 `passThruConnect` 拿到带 `writeMsgs/readMsgs` 的通道对象，或：

```js
const { ConfigParam, TxFlag } = require('./src')

const iso = await device.openIso15765({
  txId: 0x7E0,
  rxId: 0x7E8,
  // 或按 LOGICALCONNECT：
  // connectFlags, localTxFlags, remoteTxFlags,
  // localAddress: '000007E8', remoteAddress: '000007E0',
  remoteTxFlags: TxFlag.ISO15765_PAD, // 0x800040，高字节为填充值
  padValue: 0x00                      // 并进 TxFlags 高字节；要 FF 则 padValue: 0xFF → 0xFF800040
})

// 流控一般用默认；需要时再 SET_CONFIG（见 PROTOCOL.md）
await iso.setConfig([
  { paramId: ConfigParam.ISO15765_BS, value: 0 },           // 收：我们回的 FC.BS，0=不限
  { paramId: ConfigParam.ISO15765_STMIN, value: 0 },        // 收：我们回的 FC.STmin
  { paramId: ConfigParam.ISO15765_BS_TX, value: 0xffff },   // 发：FFFF=跟对方 FC.BS
  { paramId: ConfigParam.ISO15765_STMIN_TX, value: 0xffff },// 发：FFFF=跟对方 STmin
  { paramId: ConfigParam.ISO15765_N_CR_MAX, value: 1000 }   // 等 CF 超时，十进制 ms
])

const res = await iso.request('010C')
await device.readPinVoltage(16)
```

### `openIso15765` 常用参数

| 参数 | 说明 |
|------|------|
| `txId` / `rxId` | 11/29 位 CAN ID；也可用 `localAddress` / `remoteAddress` 五字节串 |
| `connectFlags` | 点对点 `0`；过滤通道加 `ISO15765_FILTER` |
| `localTxFlags` / `remoteTxFlags` | 见下表；混合寻址加 `0x80`，填充加 `0x800040` |
| `padValue` | `0`–`0xFF`，写入 Remote/Local TxFlags 高字节（有 `FRAME_PAD` 时） |
| `physicalChannel` | 已打开的 CAN 通道，避免重复 CONNECT |

| TxFlags | 含义 |
|---------|------|
| `0` | 无填充、无混合（短 DLC） |
| `0x80` | 混合寻址 ADDR_TYPE |
| `0x800040` | 填充到 8，填充字节=高 8 位（默认 00） |
| `0xFF800040` | 填充字节 FF |
| `0x8000C0` | 填充 + 混合 |

| SET_CONFIG（逻辑通道） | 默认 | 含义 |
|------------------------|------|------|
| `ISO15765_BS` `0x1E` | 0 | 我们回 FC 的 BS |
| `ISO15765_STMIN` `0x1F` | 0 | 我们回 FC 的 STmin |
| `ISO15765_BS_TX` `0x22` | FFFF | 发多帧时跟/盖对方 BS |
| `ISO15765_STMIN_TX` `0x23` | FFFF | 发多帧时跟/盖对方 STmin |
| `ISO15765_N_CR_MAX` `0x2F` | 1000 | 等 CF 超时（ms，十进制） |
| `ISO15765_PAD_VALUE` `0x2B` | 0 | 仅无 PaddingValid 时用 |

更细说明见 [PROTOCOL.md](PROTOCOL.md)「ISO15765 TxFlags / SET_CONFIG / 过滤表达式」。

## 例子

```bash
node examples/protocol.js 192.168.1.50
node examples/passthru.js 192.168.1.50
node examples/iso15765-uds.js 192.168.1.50
node examples/ble.js
```
