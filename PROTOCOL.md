# DFirst J2534 开放协议

English: [PROTOCOL.en.md](PROTOCOL.en.md) · [README.md](README.md)

DFirst VCI 对外这一套诊断协议（S2 / QX-A 等机型命令字相同）。链路两套：

1. **LAN / RDComm**：TCP 19000（`e0`），载荷外包 0x8C。
2. **BLE / BLEDL**：GATT notify/write，3 字节头 + 可选压缩/CRC + ACK。解完就是裸 `J2534_Command`，**没有 RDComm**。

LAN 发现（DNS-SD / mDNS，和 Bonjour 看的是同一套记录）：

| 项 | 值 |
|----|-----|
| 服务 | `_rdcomm._tcp.local` |
| 实例 / 主机 | `QX` + PSN（与 BLE 名相同） |
| 端口 | 19000 |
| TXT | `SV=` 软件版本，`HV=` 硬件版本 |
| 网口 | e0：lwIP `mdns_resp`；w0：ESP32 `AT+MDNS` |

查 PTR `_rdcomm._tcp.local` 得到实例，再取同包 SRV/A 即 IP。知道 PSN 时可直接查 `QXS226….local` 的 A 记录。Windows 上也可装 Bonjour 后用 `dns-sd -B _rdcomm._tcp`，不是必须。

Node SDK 入口：`device.j2534.*`（类名 `DFirstJ2534`），和下面命令表一一对应。

## 协议版本 V1 / V2（自动选择）

| 机型 | `proVersion` | 固件 | 线格式 |
|------|--------------|------|--------|
| A5 A6 C0 S0 S1 S2 D0 | **V2** | `J2534_RD` | 字段多为 **u32 小端**；应答从 ErrorCode u32 起 |
| A0 A1 A2 A3 A4（及 B0） | **V1** | `Midware/J2534` | 字段宽度更窄、**大端**；应答首字节为命令回显 |

SDK 在 `connect` 后按机型码推断，`OPEN` 时按 Activer 顺序试首选版本再 fallback；OPEN 版本串末尾 `,V2` 会校正。只读属性 `device.proVersion`；构造可选 `proVersion: 'V1'|'V2'` 强制覆盖。编解码：`device.codec` / `createCodec(ver)`。

下文命令表以 **V2** 为主（当前默认文档）。

## 1. RDComm 帧

```
偏移    长度    内容
0       4       Magic  0x01FEFFFF（大端）
4       4       Length 载荷长度（小端）
8       1       Flags  bit7=ACK  bit3=无需ACK  bit4=带 ServiceID
9       1       请求=命令字；应答=Error
10      2       Index（小端，请求/应答配对）
12      N       载荷
12+N    4       CRC32 MPEG-2（头+载荷，按 4 字节补 0 后计算）
```

局域网诊断用：

| 命令 | 值 | 载荷 |
|------|----|------|
| RequestRegister | `0x80` | 4 字节随机数。应答 CSV：`PSN,AppVer,HwVer,BootVer,...` |
| J2534Command | `0x8C` | 下面整段 J2534 命令；应答从 **ErrorCode** 起（不含固件内部 Length） |
| SetState | `0x8F` | `Type(4) + Value(4)`，连上后置 `RS_LOCAL_REGISTERED=0x4000` |
| J2534OutEvent | `0xE0` | 设备主动上报报文（JSON ActiveCommit 时） |

## 2. J2534 命令字

请求第一个字段永远是 **命令字 4 字节**。应答第一个字段永远是 **ErrorCode 4 字节**（0 = 成功，见 `ErrorCode`）。

### `0x00000001` OPEN 打开

请求：无（命令字即可）。

应答：

| 参数 | 格式 |
|------|------|
| ErrorCode | 4 字节 |
| Version | string |

Version 例：`V00.00.01,C0.00.01,C02322F00016,V00.00.00,V2`  
依次为 App 版本、硬件版本、PSN、BOOT 版本、J2534 协议版本。

### `0x00000002` CLOSE 关闭

请求：无。  
应答：ErrorCode（4 字节）。

### `0x00000003` CONNECT 连接通道

请求：

| 参数 | 格式 | 说明 |
|------|------|------|
| ConnectFlags | 4 字节 | 见下文「ConnectFlags」；CAN 常用 `CAN_ID_BOTH=0x800` |
| ProtocolID | 4 字节 | 物理协议：CAN=`5`，ETH DoIP=`0xFD`，ISO9141=`3`，ISO14230=`4`，J1850… |
| BaudRate | 4 字节 | 波特率。CAN 常用 `500000`；K 线常用 `10400` |
| PinSelect | 4 字节 | 高字节正极针脚、低字节负极。OBD CAN 6/14 → `0x060E`；`0`=设备默认针脚表 |

应答：ErrorCode、ChannelID（各 4 字节）。

V1：无 PinSelect；字段宽度更窄（见编解码）。

SDK：`device.j2534.connect({ connectFlags, protocolId, baudRate, pinSelect })`  
快捷：`device.passThruConnect({ protocol, baud, flags, pinSelect })`。

### `0x00000004` DISCONNECT 断开通道

请求：ChannelID（4 字节）。  
应答：ErrorCode、ChannelID。

### `0x00000005` READMSG 读报文

请求：

| 参数 | 说明 |
|------|------|
| ChannelID | 物理或逻辑通道 |
| MsgNum | 最多取几条（常用 8） |
| Timeout | 等待毫秒；到期若已有部分报文仍可能返回，ErrorCode 可能为 `TIMEOUT(9)` |

应答：ErrorCode、ChannelID、MsgNum，随后 `MsgNum` 条：

```
TimeStamp(4) RxStatus(4) DataSize(4) ExtraDataIndex(4) Data[DataSize]
```

| 字段 | 说明 |
|------|------|
| TimeStamp | 设备时间戳 |
| RxStatus | 见「RxStatus」；`START_OF_MESSAGE` 为首帧指示，完整 UDS 在后续 indication |
| ExtraDataIndex | 有效载荷结束下标（可选）；0 表示用整段 Data |
| Data | ISO15765：前 4 字节大端 CAN ID（混合寻址再 +1 字节 EA），其后为 UDS |

`TIMEOUT(0x09)` / `BUFFER_EMPTY(0x10)` 时仍可能带已收到的报文。

SDK：`readMsg(channelId, { msgNum, timeout })` → `{ messages: [{ rxStatus, data, … }] }`。

### `0x00000006` WRITEMSG 写报文

请求：ChannelID、MsgNum，随后每条：

| 字段 | 说明 |
|------|------|
| MsgHandle | 非 0 时发送完成会 Push TX_SUCCESS/FAILED 指示 |
| TxFlags | ISO15765 填充/混合/29 位等，见 TxFlags 表 |
| DataSize / Data | ISO15765：`canId4(txId)[+EA] + UDS`；CAN 原始同理 |

应答：ErrorCode、ChannelID、MsgNum（实际写入条数）。

SDK：`writeMsg(ch, [{ handle, txFlags, data }])`。

### `0x00000007` STARTPERIODICMSG

请求：

| 参数 | 说明 |
|------|------|
| ChannelID | 通道 |
| TimeInterval | 周期间隔（ms） |
| MsgHandle | 句柄，可 0 |
| DataSize | 有效长度 |
| TxFlags | 同 WRITE |
| PeriodMsgData[12] | 固定 12 字节槽，不足补 0；内容同 WRITE 的 Data 前缀规则 |

应答：ErrorCode、ChannelID、MsgID（用于 STOP）。

SDK：`startPeriodicMsg(ch, { interval, handle, txFlags, data })`。

### `0x00000008` STOPPERIODICMSG

请求：ChannelID、MsgID。  
应答：ErrorCode、ChannelID。

### `0x00000009` STARTMSGFILTER

请求：

| 参数 | 说明 |
|------|------|
| ChannelID | 物理 CAN：PASS/BLOCK；ISO15765 逻辑：仅 FLOW_CONTROL |
| FilterType | `1=PASS` `2=BLOCK` `3=FLOW_CONTROL` |
| LocalTxFlags | 收端侧标志（混合/29 位等） |
| RemoteTxFlags | 发端侧标志（V1 无此字段） |
| Mask[5] | 与 Pattern 按位与比较 |
| Pattern[5] | 命中的 ID（+可选 EA） |
| Exp(1) | 如何从 Argument 算对端 ID，见过滤表达式表 |
| Argument[5] | SPEC=固定 TX；OR/XOR…=运算数；也可 SDK 字段名 `flowControl` |

应答：ErrorCode、ChannelID、FilterID。

物理 PASS：进硬件验收；BLOCK：软件丢弃。ISO15765 逻辑通道只接受 FLOW_CONTROL。

SDK：`startMsgFilter(ch, { type, localTxFlags, remoteTxFlags, mask, pattern, exp, argument|flowControl })`。

### `0x0000000A` STOPMSGFILTER

请求：ChannelID、FilterID。  
应答：ErrorCode、ChannelID。

### `0x0000000C` READVERSION

同 OPEN 的应答格式。

### `0x0000000D` IOCTL

请求：ChannelID、IoctlID、InputLength、Input。  
应答：ErrorCode、OutputLength、Output。设备级 IOCTL（如读针脚电压）ChannelID 填 `0`。

| IoctlID | 名称 | Input | 说明 |
|---------|------|-------|------|
| 1 | GET_CONFIG | Num + Index[] | 读配置 |
| 2 | SET_CONFIG | Num + {Index,Value}[] | 写配置（ISO15765 流控见 LOGICALCONNECT 节） |
| 3 | READ_PIN_VOLTAGE | 针脚号 u32 | 读 OBD 针脚电压 |
| 4 | FIVE_BAUD_INIT | 1 字节地址（OBD 常用 `33`） | → Keyword KB1 KB2 |
| 5 | FAST_INIT | StartComm 报文（无校验，固件补）如 `C1 33 F1 81` | → ECU 应答 |
| 7 / 8 | CLEAR_TX / CLEAR_RX | 空 | 清队列 |
| 9 / 10 | CLEAR_PERIODIC / CLEAR_FILTERS | 空 | |
| `0x21`（SET_CONFIG） | FIVE_BAUD_MOD | 0–3 | 5 波特变体，见下 |
| `0x800A` | REQUEST_CONNECTION | TP20/TP16 结构 | 逻辑通道建链 |
| `0x800B` | TEARDOWN_CONNECTION | 空/协议相关 | 拆链 |
| `0x10001` | ETH_BMW_DISCOVERY | | BMW 以太网发现 |
| `0x10003` | ISO13400_DISCOVERY | | DoIP 发现 |
| `0x10004` | ISO13400_ROUTING_ACTIVE | 路由激活载荷 | Tester 须 `0x0E80`–`0x0EFF` |

5 波特 `FIVE_BAUD_MOD`：`0` 反码 KB2+等地址反码，`1` 只反码 KB2，`2` 只等地址反码，`3` ISO9141 标准。

#### TP20 `REQUEST_CONNECTION` Input（V2，11 字节）

| 偏移 | 字段 | 常用 |
|------|------|------|
| 0 | Setup identifier u32 | `0x200` |
| 4 | Destination | `0x01` |
| 5 | Opcode | `0xC0` |
| 6 | TxIdA u16 | |
| 8 | RxIdA u16 | |
| 10 | App | `0x01` |

V1：Dest1 + SetupID2 BE + T1 + T3（5 字节）。

#### TP16 `REQUEST_CONNECTION` Input（V2，7 字节）

| 偏移 | 字段 | 常用 |
|------|------|------|
| 0 | Setup identifier u32 | Driver `0x200`；Comfort `0x2D0` |
| 4 | Destination | Driver/Comfort `<0x20` |
| 5 | Opcode | `0xC0` |
| 6 | ChId | |

SDK：`encode.tp20RequestConnection({…})` / `tp16RequestConnection({…})` 后 `ioctl(isoId, Ioctl.REQUEST_CONNECTION, buf)`。

### `0x0000000E` LOGICALCONNECT

请求：PhyChannelID、ProtocolID、ConnectFlags、LocalTxFlags、RemoteTxFlags、LocalAddress[5]、RemoteAddress[5]。  
应答：ErrorCode、ChannelID（物理）、LogicalChannelID。

| 逻辑 ProtocolID | 物理底座 | 要点 |
|-----------------|----------|------|
| `0x200` ISO15765 | CAN | 点对点 / 过滤，见下 |
| `0x201` ISO15765_FILTER | CAN | V1 过滤通道协议号；V2 多用 `0x200`+`ConnectFlags FILTER` |
| `0x210` ISO15765_FD | CAN FD | |
| `0x300` TP20 | CAN | 打开后再 REQUEST_CONNECTION |
| `0x301` TP16 | CAN | 同上（V2） |
| `0x400` ISO13400 | ETH | 发现 → 连 → ROUTING_ACTIVE |
| `0x401` ETH_BMW | ETH | 发现 DIAGADR → UDP 6801 |
| `0x402` ETH_PASSTHRU | ETH | UDP/TCP 透传 |

**以太网 LOGICALCONNECT（V2）**：`remoteIP`→LocalTxFlags(u32)、`remotePort`→RemoteTxFlags、`localPort`+version 写入 LocalAddress[5]。SDK 传 `remoteIP/remotePort/localPort` 即可。

ISO15765：

- 点对点：`ConnectFlags=0`，固件用 LocalAddress / RemoteAddress 自动建 FLOW_CONTROL（Pattern=Local，Argument=Remote）。
- 过滤通道：`ConnectFlags=ISO15765_FILTER (0x40000000)`，地址可填 0，再 `START_MSG_FILTER`。
- 混合寻址：LocalTxFlags / RemoteTxFlags 置 `ISO15765_ADDR_TYPE (0x80)`，地址第 5 字节为扩展地址。例：Remote `00 00 06 F1 40`，Local `00 00 06 40 F1`（短帧常不配 PAD）。
- QX-A 系列逻辑 ConnectFlags 常用 `ISO15765_MINI (0x20)`；S 系列点对点常用 `0`。

#### ISO15765 TxFlags（Local / Remote / WRITE）

| 位 / 值 | 含义 |
|---------|------|
| `FRAME_PAD` `0x40` | 单帧/FC 补到 DLC=8 |
| `ADDR_TYPE` `0x80` | 混合寻址（数据前有 1 字节 EA） |
| `CAN_29BIT_ID` `0x100` | 29 位 CAN ID |
| `PADDING_VALID` `0x800000` | 高 8 位 `PaddingValue` 有效 |
| `ISO15765_PAD` `0x800040` | = `PADDING_VALID \| FRAME_PAD`（默认填充值在高字节，常为 `00`） |

填充字节：固件若见 `PADDING_VALID`，用 **TxFlags 高 8 位** 填 CAN 尾部，会盖过 `SET_CONFIG PAD_VALUE`。要补 `FF` 应写 `0xFF800040`，或 SDK 传 `padValue: 0xFF`（`openIso15765` 会并进高字节）。仅 `SET_CONFIG 0x2B` 而 TxFlags 仍是 `0x800040`（高字节 0）→ 总线上仍是 `00`。

#### ISO15765 `SET_CONFIG`（逻辑通道打开后）

`SET_CONFIG` Input：`Num` + `{ Index, Value }[]`。日常用默认即可。

| Index | 名称 | 默认 | 怎么用 |
|-------|------|------|--------|
| `0x1E` | BS | `0` | **收多帧**：我们回给 ECU 的 FC.BS。`0`=不限块。 |
| `0x1F` | STmin | `0` | **收多帧**：我们回的 FC.STmin。`0`=尽快；`1`–`7F`=ms；`F1`–`F9`=100–900µs。 |
| `0x22` | BS_TX | `0xFFFF` | **发多帧**：`FFFF`=跟对方 FC 的 BS；其它值=强制覆盖。 |
| `0x23` | STMIN_TX | `0xFFFF` | **发多帧**：`FFFF`=跟对方 STmin；`00`–`FF`=强制间隔；`80xx`=与对方取较大值。 |
| `0x2B` | PAD_VALUE | `0` | 填充字节；仅当 TxFlags **未**置 `PADDING_VALID` 时单独生效。 |
| `0x2F` | N_CR_MAX | `1000` | 等下一 CF 超时（**十进制 ms**）。 |

「FFFF=跟对方」：本端发多帧时听 ECU 回的 FC；`FFFF` 不覆盖，按 ECU 给的 BS/STmin 发 CF。

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

#### 过滤通道 `START_MSG_FILTER` 表达式 Exp / Argument

FLOW_CONTROL 时 Pattern=收到的 ID；Argument 含义随 Exp：

| Exp | 名称 | Argument |
|-----|------|----------|
| 0 | SPEC | 固定对端 TX ID（如 `7E0`） |
| 1 | EXCHANGE_EA | 固定 `0`；由 ID 低字节与 EA 对调算对端（需 ADDR_TYPE） |
| 2–6 | OR / AND / XOR / PLUS / MINUS | 运算数（常用 `8`，如 `7E8⊕8=7E0`） |
| 7 / 9 | EXCHANGE_29BIT / 29_13BIT | 参与交换的位段 |
| 8 | SINGLE_FRAME | 按固件单帧规则 |

### `0x0000000F` LOGICALDISCONNECT

请求：LogicalChannelID。  
应答：ErrorCode、ChannelID。

### `0x00000010` CUSTOM_FEATURE

请求：

| 参数 | 格式 |
|------|------|
| ChannelID | 4 字节，WiFi 填 0 |
| FeatureID | 4 字节 |
| InputLength | 4 字节 |
| Input | InputLength 字节 |

整包长度必须是 `InputLength + 16`。应答与 IOCTL 相同：ErrorCode，成功时可能带 OutputLength + Output。

QXS1 / QXS2（`J2534_HAS_WIFI_ESP32`）WiFi FeatureID：

| ID | 作用 | Input | Output |
|----|------|-------|--------|
| 0x15 | GET_WIFI_STATE | 空 | `AT+CWSTATE` 文本，如 `2,"ssid"` |
| 0x16 | SET_WIFI_SSID_PW | `ssid\\0password\\0` | 无。密码至少 2 字节 |
| 0x17 | DISC_WIFI | 空 | 无 |
| 0x18 | SCAN_WIFI | 空 | `len,ssid,ecn,rssi;` 重复 |

SDK：`device.wifiGetState()` / `wifiScan()` / `wifiConnect(ssid, pw)` / `wifiDisconnect()`。建议走 BLE 配网，连上后 w0 发 mDNS。

### 升级 `CUSTOM_FEATURE` 0x83–0x89

S2（`J2534_HAS_UPDATE_FEATURE`）写到**空闲 APP 槽**，bin 需带鉴权头。

| ID | 作用 | Input |
|----|------|--------|
| 0x83 | ENTER_UPGRADE_MODE | EraseType u32（0=APP） |
| 0x84 | GET_FLASH_INFO | 空 → Start/End/PageNum/PageSize |
| 0x85 | ERASE_FLASH | StartAddr + PageNum |
| 0x87 | PROGRAM_FLASH | StartAddr + Data（≤2048） |
| 0x88 | CHECK_FLASH | 空 |
| 0x89 | EXIT_UPGRADE_MODE | 空 |
| 0x80 | RESET_DEVICE | 空，约 500ms 后复位 |

SDK：`device.upgradeFirmware(bin, { onProgress, reboot })`。

## 3. ProtocolID

| ID | 协议 | 用法 |
|----|------|------|
| 1 / 2 | J1850 VPW / PWM | 物理 CONNECT |
| 3 / 4 | ISO9141 / ISO14230 | 物理；再 FIVE_BAUD / FAST_INIT |
| 5 | CAN | 物理；再叠 ISO15765/TP 逻辑 |
| 0xFC / 0xFE / 0xFF | LSCAN / MSCAN / SWCAN | 物理变体 |
| 0xFD | ETH DoIP | 物理以太网 / DoIP |
| 0x200 | ISO15765 | 逻辑（点对点或 +FILTER） |
| 0x201 | ISO15765_FILTER | V1 过滤逻辑协议号 |
| 0x210 / 0x211 | ISO15765 FD / FD_FILTER | CAN FD |
| 0x300 / 0x301 | TP20 / TP16 | 逻辑 + REQUEST_CONNECTION |
| 0x400 | ISO13400 DoIP | 逻辑 |
| 0x401 | ETH_BMW | 逻辑 |
| 0x402 | ETH_PASSTHRU | 逻辑透传 |

## 3.1 ConnectFlags（常用）

| 值 | 名称 | 说明 |
|----|------|------|
| `0x20` | ISO15765_MINI | QX-A 逻辑常用 |
| `0x40` | CHECK_PIN_VOLTAGE | CONNECT 时检针脚电压 |
| `0x100` | CAN_29BIT_ID | 物理偏 29 位 |
| `0x800` | CAN_ID_BOTH | CAN 物理默认：11/29 都收 |
| `0x1000` | K_LINE_ONLY | 仅 K 线 |
| `0x40000` | ETH_NO_DHCP_CLIENT | |
| `0x400000` | ETH_AUTO_IP | |
| `0x1000000` | ETH_NO_DHCP_SERVER | |
| `0x8000000` | CAN_TERMINATION | 终端电阻 |
| `0x10000000` | ACTIVE_COMMIT_SIM | |
| `0x20000000` | ACTIVE_COMMIT | |
| `0x40000000` | ISO15765_FILTER | 过滤逻辑通道 |
| `0x80000000` | ETH_TCP | 以太网 TCP |

## 3.2 RxStatus（READMSG）

| 值 | 名称 | 说明 |
|----|------|------|
| `0x1` | TX_MSG_TYPE | 发送类指示 |
| `0x2` | START_OF_MESSAGE | ISO15765 多帧开始（常仅地址，无完整 UDS） |
| `0x8` | TX_SUCCESS | 发送成功 |
| `0x10` | ISO15765_PADDING | |
| `0x80` | ISO15765_ADDR_TYPE | 混合寻址 |
| `0x100` | CAN_29BIT_ID | |
| `0x200` | TX_FAILED | 发送失败 |

完整诊断应答：跳过 TX_* / 空 SOM，取带 UDS 数据的 indication。

## 3.3 常见 ErrorCode

| 值 | 名称 | 含义 |
|----|------|------|
| 0 | NOERROR | 成功 |
| 3 | PROTOCOL_ID_NOT_SUPPORTED | 协议与物理不匹配等 |
| 6 | FLAG_NOT_SUPPORTED | ConnectFlags/TxFlags 位不被支持 |
| 9 | TIMEOUT | 读超时（可能仍有部分 Msg） |
| 0x10 | BUFFER_EMPTY | 无更多报文 |
| 0x0C | EXCEEDED_LIMIT | 通道/过滤/周期数量超限 |
| 0x14 | RESOURCE_CONFLICT | 资源冲突 |
| 0x26 | CONCURRENT_API_CALL | 并发调用 |

完整表见 `constants.js` → `ErrorCode`。

## 4. SDK 对应关系

```js
const device = new DFirstJ2534({ host })
await device.connect()           // RDComm 注册，不是 J2534 CONNECT

await device.j2534.open()        // 0x01
await device.j2534.connect({     // 0x03
  connectFlags, protocolId, baudRate, pinSelect
})
await device.j2534.readMsg(ch, { msgNum, timeout })  // 0x05
await device.j2534.writeMsg(ch, msgs)                // 0x06
await device.j2534.close()       // 0x02
```

| SDK 方法 | 主要参数 |
|----------|----------|
| `connect` | `connectFlags`, `protocolId`, `baudRate`, `pinSelect` |
| `readMsg` | `msgNum`, `timeout`(ms) |
| `writeMsg` | `[{ handle, txFlags, data }]` |
| `startPeriodicMsg` | `{ interval, handle, txFlags, data }` |
| `startMsgFilter` | `{ type, localTxFlags, remoteTxFlags, mask, pattern, exp, argument }` |
| `ioctl` | `(channelId, ioctlId, inputBuf)` |
| `logicalConnect` | `protocolId`, `connectFlags`, `localTxFlags`, `remoteTxFlags`, `localAddress`, `remoteAddress`；ETH 另加 `remoteIP`, `remotePort`, `localPort` |
| `customFeature` | `(featureId, inputBuf)` |

编解码也可单独用：`encode.connect(...)` / `decode.connect(buf)`。

## 5. BLEDL（BLE 链路）

广播名 `QX` + 12 字节 PSN。默认 ESP32 GATT 写 UUID `fee2`。

```
字节0-1  长度（大端，低 13 位；高 3 位包序号，必须为 0）
字节2    bit7-6 类型 0=DATA 1=控制 2=ACK
         bit5 CRC  bit4 压缩  bit3 加密(未实现)  bit2-0 帧序号
字节3..  载荷（压缩则先 2 字节大端原始长度）
末 4 字节  CRC32（IEEE，按 4 字节补 0，大端；载荷 >16 才带）
```

交互：主机发 DATA → 设备 ACK(1 字节 0=成功) → 设备发 DATA(J2534 应答) → 主机 ACK。

GATT 按 MTU 切片，无 JDY 那种每包 1 字节序号。Node 里 `BledlLink.request(j2534Bytes)` 完成这一轮。

