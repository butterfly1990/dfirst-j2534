# dfirst-j2534

Chinese: [README.zh.md](README.zh.md)

A **DIY Node J2534 SDK** for **QX DFirst** devices (npm: `dfirst-j2534`, class `DFirstJ2534`). The API wraps DFirst firmware command words — it is **not** a generic OBD / ELM327 library.

Companion Windows UI: [`dfirst-j2534-obdii-app`](https://github.com/butterfly1990/dfirst-j2534-obdii-app) (npm: `@butterflyer/dfirst-j2534-obdii-app`).

## Scope & host link

| Device family | BLE | LAN (Ethernet e0 / Wi‑Fi w0) |
|---------------|-----|------------------------------|
| **QX-A** series (A0–A6) | ✅ | — |
| **QX Slink** (S0 / S1 / **S2**) | ✅ | ✅ |
| **ELM327** and similar AT-command adapters | ❌ not supported | ❌ |

**Aliases (docs / product names):**

| Name | Meaning |
|------|---------|
| **QXS2** | **QX Slink WiFi** (Slink family; BLE also works) |
| **ETH DoIP** (ProtocolID `0xFD`) | Physical Ethernet / DoIP carrier; logical channel is typically **ISO13400** (DoIP) |

Wire format: [PROTOCOL.en.md](PROTOCOL.en.md).

Two transports:

| Transport | Framing | Connect |
|-----------|---------|---------|
| LAN | RDComm TCP 19000 | `{ host: 'e0 IP' }` |
| BLE | BLEDL (3-byte header / compress / CRC / ACK) | `{ transport: 'ble' }` |

J2534 encode/decode is shared. On BLE there is **no** RDComm — after GATT reassembly you get raw command bytes.

## Protocols by model

Host link: **QX-A = BLE only**; **QX Slink (S0/S1/S2) = BLE + LAN**. Below is what each model can `CONNECT` (physical) and which logical protocols open on top (same as firmware / [`dfirst-j2534-obdii-app`](https://github.com/butterfly1990/dfirst-j2534-obdii-app)). CAN-FD means FD data-phase via `SET_CONFIG` on CAN-class phys — not a separate ProtocolID.

### QX-A0 / QX-A1
- Host: BLE
- Physical: CAN
- Logical (on CAN): ISO15765, ISO15765 filter, TP20, TP16

### QX-A2
- Host: BLE
- Physical: CAN, MSCAN, ETH (DoIP)
- Logical: on CAN / MSCAN → ISO15765, ISO15765 filter, TP20, TP16; on ETH (DoIP) → ISO13400 (DoIP), ETH_BMW, ETH_PASSTHRU

### QX-A3
- Host: BLE
- Physical: CAN, MSCAN
- Logical (on CAN / MSCAN): ISO15765, ISO15765 filter, TP20, TP16

### QX-A4
- Host: BLE
- Physical: CAN, MSCAN, SWCAN, ETH (DoIP); CAN-class supports CAN-FD
- Logical: on CAN / MSCAN / SWCAN → ISO15765, ISO15765 filter, TP20, TP16; on ETH (DoIP) → ISO13400 (DoIP), ETH_BMW, ETH_PASSTHRU

### QX-A5 / QX-A6
- Host: BLE
- Physical: CAN, MSCAN, LSCAN, CAN1/9, CAN12/13, ISO14230, ISO9141, J1850VPW, J1850PWM; CAN-class supports CAN-FD
- Logical: on CAN / MSCAN / LSCAN / CAN1/9 / CAN12/13 → ISO15765, ISO15765 filter, TP20, TP16; K-line / J1850 have no logical channel (TX/RX on physical)

### QXS0
- Host: BLE, LAN
- Physical: CAN, MSCAN, SWCAN, LSCAN, CAN12/13, ETH (DoIP), ISO14230, ISO9141; CAN-class supports CAN-FD
- Logical: on CAN-class → ISO15765, ISO15765 filter, TP20, TP16; on ETH (DoIP) → ISO13400 (DoIP), ETH_BMW, ETH_PASSTHRU; K-line has no logical channel

### QXS1
- Host: BLE, LAN; Wi‑Fi STA can be provisioned over BLE then use LAN
- Physical: CAN, MSCAN, SWCAN, LSCAN, CAN12/13, ETH (DoIP), ISO14230, ISO9141, J1850VPW, J1850PWM; CAN-class supports CAN-FD
- Logical: on CAN-class → ISO15765, ISO15765 filter, TP20, TP16; on ETH (DoIP) → ISO13400 (DoIP), ETH_BMW, ETH_PASSTHRU; K-line / J1850 have no logical channel

### QXS2 (QX Slink WiFi)
- Host: BLE, LAN; Wi‑Fi STA can be provisioned over BLE then use LAN
- Physical: CAN, MSCAN, SWCAN, LSCAN, CAN12/13, ETH (DoIP), ISO14230, ISO9141, J1850VPW, J1850PWM; CAN-class supports CAN-FD
- Logical: on CAN-class → ISO15765, ISO15765 filter, TP20, TP16; on ETH (DoIP) → ISO13400 (DoIP), ETH_BMW, ETH_PASSTHRU; K-line / J1850 have no logical channel

## Install

```bash
npm i dfirst-j2534
# BLE (optional): npm i @stoprocent/noble   # Windows
#                 npm i @abandonware/noble  # Linux/macOS
```

From this repository:

```bash
git clone https://github.com/butterfly1990/dfirst-j2534.git
cd dfirst-j2534
npm install
```

```js
const { DFirstJ2534 } = require('dfirst-j2534')
```

## Connect

LAN:

```js
const found = await DFirstJ2534.scanLan({ timeout: 3000 })
const device = new DFirstJ2534({ host: found[0].host })
await device.connect()
```

Devices advertise DNS-SD on **e0** and **w0**: `QX{PSN}._rdcomm._tcp.local`, port **19000**, hostname `QX{PSN}.local`. With a known PSN you can `scanLan({ name: 'QXS226…' })` for an A record, or pass `{ host: '192.168.1.50' }`.

On Windows / macOS with **Bonjour** (`dns-sd`), LAN scan prefers system DNS-SD (UDP 5353 is often taken; raw multicast easily misses devices). Without `dns-sd`, it falls back to `multicast-dns`.

BLE (adv name `QX` / `QX-A…`). Install an adapter: `npm i @stoprocent/noble` (Windows) or `@abandonware/noble` (Linux/macOS).

```js
const found = await DFirstJ2534.scanBle({ namePrefix: 'QX', timeout: 12000 })
const device = new DFirstJ2534({ transport: 'ble' }) // optional blecfg
await device.connect(found[0])
```

| Model | J2534 | blecfg (auto) | BLE chunking |
|-------|-------|---------------|--------------|
| A0 / A1 / B0 | V1 | `FFE0-FFE1-FFE1-FFE1-14-20` | **JDY** (≤20B + seq header; most PC stacks unsupported) |
| A2 / A3 / A4 | V1 | `FFE1-FFE3-FFE1-FFE2-200-D4` | MTU−12 slices (no seq header) |
| A5 / A6 | V2 | `FFE1-FFE3-FFE1-FFE2-2000-D4` | same |
| C0 | V2 | `FEE0-FEE1-FEE2-FEE2-200-C0` | same |
| S0 / S1 / S2 | V2 | (default A002 profile) | ESP32 GATT |

GATT tries the table / `PROFILES` UUIDs. In your own code, pass constructor `blecfg` to override. Companion UI [`@butterflyer/dfirst-j2534-obdii-app`](https://www.npmjs.com/package/@butterflyer/dfirst-j2534-obdii-app) auto-fills `blecfg` by model (read-only).

`device.j2534.*` is transport-agnostic.

QXS1 / QXS2 can provision Wi‑Fi over BLE (ESP32 STA):

```js
const aps = await device.wifiScan()           // CUSTOM_FEATURE 0x18
const st = await device.wifiGetState()        // 0x15  → { state, ssid, label }
await device.wifiConnect('MyAP', 'password')  // 0x16
await device.wifiDisconnect()                 // 0x17
```

After join, the device advertises `_rdcomm._tcp` on **w0** — you can switch to LAN.

## Protocol API `device.j2534`

Maps 1:1 to command IDs; returns `{ error, ... }`:

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

| Method | Cmd | Request | Response |
|--------|-----|---------|----------|
| `open` | `0x01` | none | `{ error, version }` |
| `close` | `0x02` | none | `{ error }` |
| `connect` | `0x03` | `connectFlags`, `protocolId`, `baudRate`, `pinSelect` | `{ error, channelId }` |
| `disconnect` | `0x04` | `channelId` | `{ error, channelId }` |
| `readMsg` | `0x05` | `{ msgNum=8, timeout=1000 }` | `{ error, messages[] }` each: `rxStatus`, `data`, `extraDataIndex` |
| `writeMsg` | `0x06` | `[{ handle, txFlags, data }]` | `{ error, msgNum }` |
| `startPeriodicMsg` | `0x07` | `{ interval, handle, txFlags, data }` | `{ error, msgId }` |
| `stopPeriodicMsg` | `0x08` | `msgId` | `{ error }` |
| `startMsgFilter` | `0x09` | `{ type, localTxFlags, remoteTxFlags, mask, pattern, exp, argument\|flowControl }` | `{ error, id: filterId }` |
| `stopMsgFilter` | `0x0A` | `filterId` | `{ error }` |
| `readVersion` | `0x0C` | none | `{ error, version }` |
| `ioctl` | `0x0D` | `(channelId, ioctlId, inputBuf)` | `{ error, output }` |
| `logicalConnect` | `0x0E` | see table below | `{ error, channelId, logicalChannelId }` |
| `logicalDisconnect` | `0x0F` | `channelId` | `{ error }` |
| `customFeature` | `0x10` | `(featureId, inputBuf)` | `{ error, output? }` |
| `exec` | any | pre-encoded Buffer | `{ error, raw }` |

### `connect` / `logicalConnect` parameters

| Param | CONNECT (physical) | LOGICALCONNECT |
|-------|--------------------|----------------|
| `protocolId` | CAN=5, ETH=0xFD, ISO9141=3… | ISO15765=0x200, TP20=0x300, ISO13400=0x400… |
| `connectFlags` | CAN often `CAN_ID_BOTH`; ETH DHCP/AUTO_IP | point-to-point 0 or MINI; filter → `ISO15765_FILTER` |
| `baudRate` | CAN 500000; K-line 10400 | (inherits physical) |
| `pinSelect` | `pinSelect(6,14)`→`0x060E`; 0=default | — |
| `localTxFlags` / `remoteTxFlags` | — | pad / mixed / 29-bit; ETH reuses for IP/port |
| `localAddress` / `remoteAddress` | — | 5-byte addr; or `canId5` / `addr5` |
| `remoteIP` / `remotePort` / `localPort` | — | ETH logical only |

### `readMsg` / `writeMsg`

- **Read**: `timeout` in ms; on `TIMEOUT` / `BUFFER_EMPTY`, `messages` may still be non-empty. Skip `TX_*` and empty `START_OF_MESSAGE`; take indications that carry UDS.
- **Write**: ISO15765 `data` = `canId4(txId)[+1 EA] + UDS`; `txFlags` should match logical Remote (pad / mixed).

### `startMsgFilter`

| `type` | Channel | Notes |
|--------|---------|-------|
| PASS=1 / BLOCK=2 | physical CAN | Mask/Pattern accept or drop |
| FLOW_CONTROL=3 | ISO15765 logical | Pattern=RX; `exp`+`argument` compute TX |

`argument` and `flowControl` are aliases (5 bytes). Exp table: [PROTOCOL.en.md](PROTOCOL.en.md).

ISO15765 `data` starts with a big-endian CAN ID (4 bytes), then UDS. Wire format details: [PROTOCOL.en.md](PROTOCOL.en.md).

Codec helpers: `encode.connect(...)`, `decode.readMsg(buf)`.

## Shortcuts

Or use `passThruConnect` channels with `writeMsgs` / `readMsgs`, or:

```js
const { ConfigParam, TxFlag } = require('./src')

const iso = await device.openIso15765({
  txId: 0x7E0,
  rxId: 0x7E8,
  // or LOGICALCONNECT-style:
  // connectFlags, localTxFlags, remoteTxFlags,
  // localAddress: '000007E8', remoteAddress: '000007E0',
  remoteTxFlags: TxFlag.ISO15765_PAD, // 0x800040; pad byte in high byte
  padValue: 0x00                      // merged into TxFlags; 0xFF → 0xFF800040
})

// Flow control usually left at defaults; optional SET_CONFIG (see PROTOCOL.en.md)
await iso.setConfig([
  { paramId: ConfigParam.ISO15765_BS, value: 0 },           // RX: our FC.BS, 0=unlimited
  { paramId: ConfigParam.ISO15765_STMIN, value: 0 },        // RX: our FC.STmin
  { paramId: ConfigParam.ISO15765_BS_TX, value: 0xffff },   // TX: FFFF=follow peer FC.BS
  { paramId: ConfigParam.ISO15765_STMIN_TX, value: 0xffff },// TX: FFFF=follow peer STmin
  { paramId: ConfigParam.ISO15765_N_CR_MAX, value: 1000 }   // wait CF timeout, decimal ms
])

const res = await iso.request('010C')
await device.readPinVoltage(16)
```

### `openIso15765` common options

| Option | Meaning |
|--------|---------|
| `txId` / `rxId` | 11/29-bit CAN IDs; or 5-byte `localAddress` / `remoteAddress` |
| `connectFlags` | point-to-point `0`; filter channel add `ISO15765_FILTER` |
| `localTxFlags` / `remoteTxFlags` | see table; mixed `0x80`, pad `0x800040` |
| `padValue` | `0`–`0xFF` into TxFlags high byte when `FRAME_PAD` |
| `physicalChannel` | existing CAN channel (skip second CONNECT) |

| TxFlags | Meaning |
|---------|---------|
| `0` | no pad, no mixed (short DLC) |
| `0x80` | mixed ADDR_TYPE |
| `0x800040` | pad to 8; pad byte = high 8 bits (default 00) |
| `0xFF800040` | pad byte FF |
| `0x8000C0` | pad + mixed |

| SET_CONFIG (logical) | Default | Meaning |
|----------------------|---------|---------|
| `ISO15765_BS` `0x1E` | 0 | BS in FC we send |
| `ISO15765_STMIN` `0x1F` | 0 | STmin in FC we send |
| `ISO15765_BS_TX` `0x22` | FFFF | TX: follow/override peer BS |
| `ISO15765_STMIN_TX` `0x23` | FFFF | TX: follow/override peer STmin |
| `ISO15765_N_CR_MAX` `0x2F` | 1000 | CF wait timeout (ms, **decimal**) |
| `ISO15765_PAD_VALUE` `0x2B` | 0 | used only if PaddingValid clear |

More detail: [PROTOCOL.en.md](PROTOCOL.en.md) (TxFlags / SET_CONFIG / filter Exp).

## Examples

`examples/` is in this repo (not in the npm tarball). After clone:

```bash
cd dfirst-j2534
node examples/protocol.js 192.168.1.50
node examples/passthru.js 192.168.1.50
node examples/iso15765-uds.js 192.168.1.50
node examples/ble.js
```
