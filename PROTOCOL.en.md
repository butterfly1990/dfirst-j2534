Chinese: [PROTOCOL.md](PROTOCOL.md)

# DFirst J2534 Open Protocol

English: [PROTOCOL.en.md](PROTOCOL.en.md) · [README.en.md](README.en.md)

DFirst VCI public diagnostic protocol (same command IDs on S2 / QX-A). Two links:

1. **LAN / RDComm**: TCP 19000 (`e0`), payload wrapped as 0x8C.
2. **BLE / BLEDL**: GATT notify/write, 3-byte header + optional compress/CRC + ACK. After decode: raw `J2534_Command` — **no RDComm**.

LAN discovery (DNS-SD / mDNS; same records Bonjour would see):

| Item | Value |
|----|-----|
| Service | `_rdcomm._tcp.local` |
| Instance / host | `QX` + PSN (same as BLE name) |
| Port | 19000 |
| TXT | `SV=` 软件版本，`HV=` 硬件版本 |
| NIC | e0: lwIP `mdns_resp`; w0: ESP32 `AT+MDNS` |

Query PTR `_rdcomm._tcp.local` for the instance, then SRV/A for IP. With known PSN, query A for `QXS226….local`. Bonjour/`dns-sd` on Windows is optional.

Node SDK entry: `device.j2534.*` (class `DFirstJ2534`), 1:1 with commands below.

## Protocol version V1 / V2 (auto)

| Model | `proVersion` | Firmware | Wire format |
|------|--------------|------|--------|
| A5 A6 C0 S0 S1 S2 D0 | **V2** | `J2534_RD` | fields mostly **u32 LE**; response starts at ErrorCode u32 |
| A0 A1 A2 A3 A4 (and B0) | **V1** | `Midware/J2534` | narrower fields, **BE**; first response byte is command echo |

After `connect`, SDK infers model; on `OPEN` tries preferred version then fallback. Trailing `,V2` in version string corrects. Read-only `device.proVersion`; ctor may force `proVersion`. Codec: `device.codec` / `createCodec(ver)`.

Tables below are **V2**-centric (default docs).

## 1. RDComm frame

```
Offset  Len     Content
0       4       Magic  0x01FEFFFF (BE)
4       4       Length payload length (LE)
8       1       Flags  bit7=ACK  bit3=no-ACK  bit4=has ServiceID
9       1       req=command; rsp=Error
10      2       Index (LE, request/response pair)
12      N       Payload
12+N    4       CRC32 MPEG-2（头+Payload，按 4 bytes补 0 后计算）
```

LAN diagnostic usage:

| 命令 | 值 | Payload |
|------|----|------|
| RequestRegister | `0x80` | 4-byte random. Response CSV:`PSN,AppVer,HwVer,BootVer,...` |
| J2534Command | `0x8C` | full J2534 command; response starts at **ErrorCode** (no internal Length) |
| SetState | `0x8F` | `Type(4) + Value(4)`，set after connect `RS_LOCAL_REGISTERED=0x4000` |
| J2534OutEvent | `0xE0` | device push (JSON ActiveCommit) |

## 2. J2534 commands

First request field is always **CommandID 4 bytes**. First response field is always **ErrorCode 4 bytes** (0 = OK).

### `0x00000001` OPEN

Request: none (command ID only).

Response:

| Field | Format |
|------|------|
| ErrorCode | 4 bytes |
| Version | string |

Version e.g. `V00.00.01,C0.00.01,C02322F00016,V00.00.00,V2`  
App version, hardware version, PSN, BOOT version, J2534 protocol version.

### `0x00000002` CLOSE

Request: none.  
Response:ErrorCode（4 bytes）。

### `0x00000003` CONNECT

Request:

| Field | Format | Notes |
|------|------|------|
| ConnectFlags | 4 bytes | see ConnectFlags below; CAN often `CAN_ID_BOTH=0x800` |
| ProtocolID | 4 bytes | physical: CAN=`5`, ETH=`0xFD`, ISO9141=`3`, ISO14230=`4`, J1850… |
| BaudRate | 4 bytes | baud. CAN often `500000`; K-line often `10400` |
| PinSelect | 4 bytes | high byte +pin, low byte −pin. OBD CAN 6/14 → `0x060E`; `0`=device default pin map |

Response:ErrorCode、ChannelID（各 4 bytes）。

V1: no PinSelect; narrower fields (see codec).

SDK：`device.j2534.connect({ connectFlags, protocolId, baudRate, pinSelect })`  
Shortcut:`device.passThruConnect({ protocol, baud, flags, pinSelect })`。

### `0x00000004` DISCONNECT

Request:ChannelID（4 bytes）。  
Response:ErrorCode、ChannelID。

### `0x00000005` READMSG

Request:

| 参数 | Notes |
|------|------|
| ChannelID | physical or logical channel |
| MsgNum | max messages (often 8) |
| Timeout | wait ms; may still return partial msgs with `TIMEOUT(9)` |

Response:ErrorCode、ChannelID、MsgNum，随后 `MsgNum` 条：

```
TimeStamp(4) RxStatus(4) DataSize(4) ExtraDataIndex(4) Data[DataSize]
```

| Field | Notes |
|------|------|
| TimeStamp | device timestamp |
| RxStatus | see RxStatus; `START_OF_MESSAGE` is SOM; full UDS often in a later indication |
| ExtraDataIndex | 有效Payload结束下标（可选）；0 表示用整段 Data |
| Data | ISO15765: BE CAN ID 4 bytes (+1 EA if mixed), then UDS |

`TIMEOUT(0x09)` / `BUFFER_EMPTY(0x10)` may still include received messages.

SDK：`readMsg(channelId, { msgNum, timeout })` → `{ messages: [{ rxStatus, data, … }] }`。

### `0x00000006` WRITEMSG

Request:ChannelID、MsgNum，随后每条：

| Field | Notes |
|------|------|
| MsgHandle | non-zero → TX_SUCCESS/FAILED indication after send |
| TxFlags | ISO15765 pad/mixed/29-bit — see TxFlags |
| DataSize / Data | ISO15765: `canId4(txId)[+EA] + UDS`; raw CAN similar |

Response:ErrorCode、ChannelID、MsgNum（实际写入条数）。

SDK：`writeMsg(ch, [{ handle, txFlags, data }])`。

### `0x00000007` STARTPERIODICMSG

Request:

| 参数 | Notes |
|------|------|
| ChannelID | channel |
| TimeInterval | period interval (ms) |
| MsgHandle | handle, may be 0 |
| DataSize | valid length |
| TxFlags | same as WRITE |
| PeriodMsgData[12] | 固定 12 字节槽，不足补 0；内容same as WRITE 的 Data 前缀规则 |

Response:ErrorCode、ChannelID、MsgID（用于 STOP）。

SDK：`startPeriodicMsg(ch, { interval, handle, txFlags, data })`。

### `0x00000008` STOPPERIODICMSG

Request:ChannelID、MsgID。  
Response:ErrorCode、ChannelID。

### `0x00000009` STARTMSGFILTER

Request:

| 参数 | Notes |
|------|------|
| ChannelID | physical CAN: PASS/BLOCK; ISO15765 logical: FLOW_CONTROL only |
| FilterType | `1=PASS` `2=BLOCK` `3=FLOW_CONTROL` |
| LocalTxFlags | RX-side flags (mixed/29-bit) |
| RemoteTxFlags | TX-side flags (absent on V1) |
| Mask[5] | bitwise AND compare with Pattern |
| Pattern[5] | matching ID (+ optional EA) |
| Exp(1) | how Argument yields peer ID — see Exp table |
| Argument[5] | SPEC=fixed TX; OR/XOR…=operand; SDK alias `flowControl` |

Response:ErrorCode、ChannelID、FilterID。

物理 PASS：进硬件验收；BLOCK：软件丢弃。ISO15765 logical channel只接受 FLOW_CONTROL。

SDK：`startMsgFilter(ch, { type, localTxFlags, remoteTxFlags, mask, pattern, exp, argument|flowControl })`。

### `0x0000000A` STOPMSGFILTER

Request:ChannelID、FilterID。  
Response:ErrorCode、ChannelID。

### `0x0000000C` READVERSION

Same response format as OPEN.

### `0x0000000D` IOCTL

Request:ChannelID、IoctlID、InputLength、Input。  
Response:ErrorCode、OutputLength、Output。设备级 IOCTL（如读针脚电压）ChannelID 填 `0`。

| IoctlID | Name | Input | Notes |
|---------|------|-------|------|
| 1 | GET_CONFIG | Num + Index[] | get config |
| 2 | SET_CONFIG | Num + {Index,Value}[] | set config (ISO15765 flow control — LOGICALCONNECT section) |
| 3 | READ_PIN_VOLTAGE | pin u32 | read OBD pin voltage |
| 4 | FIVE_BAUD_INIT | 1-byte address (OBD often `33`) | → Keyword KB1 KB2 |
| 5 | FAST_INIT | StartComm frame (no checksum; FW adds), e.g. `C1 33 F1 81` | -> ECU response |
| 7 / 8 | CLEAR_TX / CLEAR_RX | 空 | clear queues |
| 9 / 10 | CLEAR_PERIODIC / CLEAR_FILTERS | 空 | |
| `0x21`（SET_CONFIG） | FIVE_BAUD_MOD | 0–3 | 5-baud variant, see below |
| `0x800A` | REQUEST_CONNECTION | TP20/TP16 结构 | logical channellink setup |
| `0x800B` | TEARDOWN_CONNECTION | 空/协议相关 | teardown |
| `0x10001` | ETH_BMW_DISCOVERY | | BMW Ethernet discovery |
| `0x10003` | ISO13400_DISCOVERY | | DoIP discovery |
| `0x10004` | ISO13400_ROUTING_ACTIVE | 路由激活Payload | Tester must be `0x0E80`–`0x0EFF` |

5-baud `FIVE_BAUD_MOD`: `0` invert KB2+addr, `1` invert KB2 only, `2` invert addr only, `3` ISO9141 std.

#### TP20 `REQUEST_CONNECTION` Input (V2, 11 bytes)

| Off | Field | Typical |
|------|------|------|
| 0 | Setup identifier u32 | `0x200` |
| 4 | Destination | `0x01` |
| 5 | Opcode | `0xC0` |
| 6 | TxIdA u16 | |
| 8 | RxIdA u16 | |
| 10 | App | `0x01` |

V1: Dest1 + SetupID2 BE + T1 + T3 (5 bytes).

#### TP16 `REQUEST_CONNECTION` Input (V2, 7 bytes)

| Off | Field | Typical |
|------|------|------|
| 0 | Setup identifier u32 | Driver `0x200`; Comfort `0x2D0` |
| 4 | Destination | Driver/Comfort `<0x20` |
| 5 | Opcode | `0xC0` |
| 6 | ChId | |

SDK：`encode.tp20RequestConnection({…})` / `tp16RequestConnection({…})` 后 `ioctl(isoId, Ioctl.REQUEST_CONNECTION, buf)`。

### `0x0000000E` LOGICALCONNECT

Request:PhyChannelID、ProtocolID、ConnectFlags、LocalTxFlags、RemoteTxFlags、LocalAddress[5]、RemoteAddress[5]。  
Response:ErrorCode、ChannelID（物理）、LogicalChannelID。

| Logical ProtocolID | Physical base | Notes |
|-----------------|----------|------|
| `0x200` ISO15765 | CAN | point-to-point / filter — below |
| `0x201` ISO15765_FILTER | CAN | V1 Filter channel协议号；V2 多用 `0x200`+`ConnectFlags FILTER` |
| `0x210` ISO15765_FD | CAN FD | |
| `0x300` TP20 | CAN | then REQUEST_CONNECTION |
| `0x301` TP16 | CAN | same (V2) |
| `0x400` ISO13400 | ETH | discover → connect → ROUTING_ACTIVE |
| `0x401` ETH_BMW | ETH | discover DIAGADR → UDP 6801 |
| `0x402` ETH_PASSTHRU | ETH | UDP/TCP passthrough |

**Ethernet LOGICALCONNECT (V2)**: `remoteIP`→LocalTxFlags(u32), `remotePort`→RemoteTxFlags, `localPort`+version in LocalAddress[5]. SDK: pass `remoteIP/remotePort/localPort`.

ISO15765：

- Point-to-point: `ConnectFlags=0`; FW builds FLOW_CONTROL from addresses (Pattern=Local, Argument=Remote).
- Filter channel：`ConnectFlags=ISO15765_FILTER (0x40000000)`，地址可填 0，再 `START_MSG_FILTER`。
- Mixed addressing: set `ISO15765_ADDR_TYPE (0x80)`; 5th address byte is EA. e.g. Remote `00 00 06 F1 40`, Local `00 00 06 40 F1` (short DLC often without PAD).
- QX-A logical ConnectFlags often `ISO15765_MINI (0x20)`; S-series point-to-point often `0`.

#### ISO15765 TxFlags (Local / Remote / WRITE)

| Bit / value | Meaning |
|---------|------|
| `FRAME_PAD` `0x40` | pad SF/FC to DLC=8 |
| `ADDR_TYPE` `0x80` | mixed addressing (1-byte EA before data) |
| `CAN_29BIT_ID` `0x100` | 29-bit CAN ID |
| `PADDING_VALID` `0x800000` | high 8 bits `PaddingValue` valid |
| `ISO15765_PAD` `0x800040` | = `PADDING_VALID | FRAME_PAD` (pad byte in high byte, often `00`) |

Pad byte: if `PADDING_VALID`, FW uses **TxFlags high 8 bits** and overrides `SET_CONFIG PAD_VALUE`. For `FF` use `0xFF800040` or SDK `padValue: 0xFF`. `SET_CONFIG 0x2B` alone with `0x800040` (high byte 0) still pads `00` on the bus.

#### ISO15765 `SET_CONFIG`（logical channel打开后）

`SET_CONFIG` Input: `Num` + `{ Index, Value }[]`. Defaults are fine for most cars.

| Index | Name | Default | Usage |
|-------|------|------|--------|
| `0x1E` | BS | `0` | **RX multi-frame**: BS in FC we send. `0`=unlimited. |
| `0x1F` | STmin | `0` | **RX multi-frame**: STmin in FC we send. `0`=ASAP; `1`–`7F`=ms; `F1`–`F9`=100–900µs. |
| `0x22` | BS_TX | `0xFFFF` | **TX multi-frame**: `FFFF`=follow peer FC.BS; other=force override. |
| `0x23` | STMIN_TX | `0xFFFF` | **TX multi-frame**: `FFFF`=follow peer STmin; `00`–`FF`=force; `80xx`=max(peer, config). |
| `0x2B` | PAD_VALUE | `0` | pad byte; only if TxFlags **lacks** `PADDING_VALID`. |
| `0x2F` | N_CR_MAX | `1000` | wait next CF timeout (**decimal ms**). |

`FFFF`=follow peer: when we TX multi-frame, use BS/STmin from ECU FC; do not override.

SDK：

```js
await iso.setConfig([
  { paramId: ConfigParam.ISO15765_BS, value: 0 },
  { paramId: ConfigParam.ISO15765_STMIN, value: 0 },
  { paramId: ConfigParam.ISO15765_BS_TX, value: 0xffff },
  { paramId: ConfigParam.ISO15765_STMIN_TX, value: 0xffff },
  { paramId: ConfigParam.ISO15765_N_CR_MAX, value: 1000 }
])
```

#### Filter channel `START_MSG_FILTER` Exp / Argument

For FLOW_CONTROL, Pattern=RX ID; Argument depends on Exp:

| Exp | Name | Argument |
|-----|------|----------|
| 0 | SPEC | fixed peer TX ID (e.g. `7E0`) |
| 1 | EXCHANGE_EA | fixed `0`; swap ID low byte with EA (needs ADDR_TYPE) |
| 2–6 | OR / AND / XOR / PLUS / MINUS | operand (often `8`, e.g. `7E8⊕8=7E0`) |
| 7 / 9 | EXCHANGE_29BIT / 29_13BIT | bits involved in exchange |
| 8 | SINGLE_FRAME | firmware single-frame rule |

### `0x0000000F` LOGICALDISCONNECT

Request:LogicalChannelID。  
Response:ErrorCode、ChannelID。

### `0x00000010` CUSTOM_FEATURE

Request:

| Field | Format |
|------|------|
| ChannelID | 4 bytes; WiFi use 0 |
| FeatureID | 4 bytes |
| InputLength | 4 bytes |
| Input | InputLength 字节 |

Total length must be `InputLength + 16`. Response like IOCTL: ErrorCode, optional OutputLength+Output.

QXS1 / QXS2（`J2534_HAS_WIFI_ESP32`）WiFi FeatureID：

| ID | Role | Input | Output |
|----|------|-------|--------|
| 0x15 | GET_WIFI_STATE | 空 | `AT+CWSTATE` 文本，如 `2,"ssid"` |
| 0x16 | SET_WIFI_SSID_PW | `ssid\\0password\\0` | none. password ≥ 2 bytes |
| 0x17 | DISC_WIFI | 空 | 无 |
| 0x18 | SCAN_WIFI | 空 | `len,ssid,ecn,rssi;` 重复 |

SDK：`device.wifiGetState()` / `wifiScan()` / `wifiConnect(ssid, pw)` / `wifiDisconnect()`。Prefer BLE provisioning; then w0 advertises mDNS.

### Upgrade `CUSTOM_FEATURE` 0x83–0x89

S2 (`J2534_HAS_UPDATE_FEATURE`) writes the **idle APP slot**; bin needs auth header.

| ID | Role | Input |
|----|------|--------|
| 0x83 | ENTER_UPGRADE_MODE | EraseType u32（0=APP） |
| 0x84 | GET_FLASH_INFO | empty → Start/End/PageNum/PageSize |
| 0x85 | ERASE_FLASH | StartAddr + PageNum |
| 0x87 | PROGRAM_FLASH | StartAddr + Data（≤2048） |
| 0x88 | CHECK_FLASH | 空 |
| 0x89 | EXIT_UPGRADE_MODE | 空 |
| 0x80 | RESET_DEVICE | empty; reset ~500ms later |

SDK：`device.upgradeFirmware(bin, { onProgress, reboot })`。

## 3. ProtocolID

| ID | Protocol | Usage |
|----|------|------|
| 1 / 2 | J1850 VPW / PWM | physical CONNECT |
| 3 / 4 | ISO9141 / ISO14230 | physical; then FIVE_BAUD / FAST_INIT |
| 5 | CAN | physical; then ISO15765/TP logical |
| 0xFC / 0xFE / 0xFF | LSCAN / MSCAN / SWCAN | physical variants |
| 0xFD | ETH | physical Ethernet |
| 0x200 | ISO15765 | logical (P2P or +FILTER) |
| 0x201 | ISO15765_FILTER | V1 filter logical protocol |
| 0x210 / 0x211 | ISO15765 FD / FD_FILTER | CAN FD |
| 0x300 / 0x301 | TP20 / TP16 | logical + REQUEST_CONNECTION |
| 0x400 | ISO13400 DoIP | logical |
| 0x401 | ETH_BMW | logical |
| 0x402 | ETH_PASSTHRU | logical passthrough |

## 3.1 ConnectFlags (common)

| Value | Name | Notes |
|----|------|------|
| `0x20` | ISO15765_MINI | QX-A logicalTypical |
| `0x40` | CHECK_PIN_VOLTAGE | check pin voltage on CONNECT |
| `0x100` | CAN_29BIT_ID | prefer 29-bit on physical |
| `0x800` | CAN_ID_BOTH | CAN physical default: accept 11/29 |
| `0x1000` | K_LINE_ONLY | K-line only |
| `0x40000` | ETH_NO_DHCP_CLIENT | |
| `0x400000` | ETH_AUTO_IP | |
| `0x1000000` | ETH_NO_DHCP_SERVER | |
| `0x8000000` | CAN_TERMINATION | termination |
| `0x10000000` | ACTIVE_COMMIT_SIM | |
| `0x20000000` | ACTIVE_COMMIT | |
| `0x40000000` | ISO15765_FILTER | 过滤logical channel |
| `0x80000000` | ETH_TCP | Ethernet TCP |

## 3.2 RxStatus (READMSG)

| Value | Name | Notes |
|----|------|------|
| `0x1` | TX_MSG_TYPE | TX-class indication |
| `0x2` | START_OF_MESSAGE | ISO15765 multi-frame start (often address only, no full UDS) |
| `0x8` | TX_SUCCESS | TX success |
| `0x10` | ISO15765_PADDING | |
| `0x80` | ISO15765_ADDR_TYPE | mixed addressing |
| `0x100` | CAN_29BIT_ID | |
| `0x200` | TX_FAILED | TX failed |

完整诊断Response:跳过 TX_* / 空 SOM，取带 UDS 数据的 indication。

## 3.3 Common ErrorCode

| Value | Name | Meaning |
|----|------|------|
| 0 | NOERROR | OK |
| 3 | PROTOCOL_ID_NOT_SUPPORTED | protocol/physical mismatch, etc. |
| 6 | FLAG_NOT_SUPPORTED | unsupported ConnectFlags/TxFlags bit |
| 9 | TIMEOUT | read timeout (may still have msgs) |
| 0x10 | BUFFER_EMPTY | no more messages |
| 0x0C | EXCEEDED_LIMIT | channel/过滤/周期数量超限 |
| 0x14 | RESOURCE_CONFLICT | resource conflict |
| 0x26 | CONCURRENT_API_CALL | concurrent API call |

Full table: `constants.js` → `ErrorCode`.

## 4. SDK mapping

```js
const device = new DFirstJ2534({ host })
await device.connect()           // RDComm register, not J2534 CONNECT

await device.j2534.open()        // 0x01
await device.j2534.connect({     // 0x03
  connectFlags, protocolId, baudRate, pinSelect
})
await device.j2534.readMsg(ch, { msgNum, timeout })  // 0x05
await device.j2534.writeMsg(ch, msgs)                // 0x06
await device.j2534.close()       // 0x02
```

| SDK method | Main params |
|----------|----------|
| `connect` | `connectFlags`, `protocolId`, `baudRate`, `pinSelect` |
| `readMsg` | `msgNum`, `timeout`(ms) |
| `writeMsg` | `[{ handle, txFlags, data }]` |
| `startPeriodicMsg` | `{ interval, handle, txFlags, data }` |
| `startMsgFilter` | `{ type, localTxFlags, remoteTxFlags, mask, pattern, exp, argument }` |
| `ioctl` | `(channelId, ioctlId, inputBuf)` |
| `logicalConnect` | `protocolId`, `connectFlags`, `localTxFlags`, `remoteTxFlags`, `localAddress`, `remoteAddress`；ETH also `remoteIP`, `remotePort`, `localPort` |
| `customFeature` | `(featureId, inputBuf)` |

Codec also usable alone: `encode.connect(...)` / `decode.connect(buf)`.

## 5. BLEDL (BLE link)

Adv name `QX` + 12-byte PSN. Default ESP32 GATT write UUID `fee2`.

```
Bytes 0-1  length (BE, low 13 bits; high 3 bits pkt seq must be 0)
Byte 2    bit7-6 type 0=DATA 1=ctrl 2=ACK
         bit5 CRC  bit4 compress  bit3 encrypt(n/a)  bit2-0 frame seq
字节3..  Payload（压缩则先 2 字节大端原始长度）
末 4 bytes  CRC32（IEEE，按 4 bytes补 0，大端；Payload >16 才带）
```

交互：主机发 DATA → 设备 ACK(1 字节 0=OK) → 设备发 DATA(J2534 应答) → 主机 ACK。

GATT slices by MTU (no JDY per-chunk seq). Node: `BledlLink.request(j2534Bytes)`.

