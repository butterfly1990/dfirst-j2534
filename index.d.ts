export const Command: {
  OPEN: 0x00000001
  CLOSE: 0x00000002
  CONNECT: 0x00000003
  DISCONNECT: 0x00000004
  READ_MSG: 0x00000005
  WRITE_MSG: 0x00000006
  START_PERIODIC_MSG: 0x00000007
  STOP_PERIODIC_MSG: 0x00000008
  START_MSG_FILTER: 0x00000009
  STOP_MSG_FILTER: 0x0000000A
  SET_PROGRAMMING_VOLTAGE: 0x0000000B
  READ_VERSION: 0x0000000C
  IOCTL: 0x0000000D
  LOGICAL_CONNECT: 0x0000000E
  LOGICAL_DISCONNECT: 0x0000000F
  CUSTOM_FEATURE: 0x00000010
}

export const Protocol: Record<string, number>
export const ProtocolName: Record<number, string>
export const ConnectFlag: Record<string, number>
export const TxFlag: Record<string, number>
export const RxStatus: Record<string, number>
export const FilterType: { PASS: 1; BLOCK: 2; FLOW_CONTROL: 3 }
export const FilterExp: {
  SPEC: 0
  EXCHANGE_EA: 1
  OR: 2
  AND: 3
  XOR: 4
  PLUS: 5
  MINUS: 6
  EXCHANGE_29BIT: 7
  SINGLE_FRAME: 8
  EXCHANGE_29_13BIT: 9
  EXCHANGE_1_x_6_3_BIT: 10
  SPEC_LIST_BLOCK: 0xE0
  MASK_PATTERN_BLOCK: 0xE1
  SPEC_LIST: 0xF0
}
export const Ioctl: Record<string, number>
export const ConfigParam: Record<string, number>
export const FiveBaudMod: { STD_INIT: 0; INV_KB2: 1; INC_ADDR: 2; ISO9141_STD: 3 }
export const CustomFeature: Record<string, number>
export const EraseType: { APP: 0; RESC: 1 }
export const VersionType: Record<string, number>
export const WifiState: Record<string, number>
export const WifiStateName: Record<number, string>
export const WifiEcnName: Record<number, string>
export const ErrorCode: Record<string, number>
export const CommandName: Record<number, string>
export const ErrorName: Record<number, string>

export function pinSelect(plusPin: number, minusPin?: number): number
export function scanLan(opts?: {
  timeout?: number
  name?: string
  interface?: string
}): Promise<{
  id: string
  name: string
  host: string
  port: number
  hostname?: string
  psn?: string
  txt?: Record<string, string>
  transport: 'lan'
}[]>

export function canId4(id: number): Buffer
export function canId5(id: number, extra?: number): Buffer
export function addr5(input: Buffer | string | number | number[], extra?: number): Buffer

export interface J2534ErrorResult {
  error: number
}

export interface J2534OpenResult extends J2534ErrorResult {
  version: string
}

export interface J2534ChannelResult extends J2534ErrorResult {
  channelId: number
}

export interface J2534IdResult extends J2534ChannelResult {
  id: number
}

export interface J2534WriteResult extends J2534ChannelResult {
  msgNum: number
}

export interface J2534Message {
  timestamp: number
  rxStatus: number
  dataSize: number
  extraDataIndex: number
  data: Buffer
}

export interface J2534ReadResult extends J2534ChannelResult {
  msgNum: number
  messages: J2534Message[]
}

export interface J2534IoctlResult extends J2534ErrorResult {
  outputLength?: number
  output: Buffer
}

export interface J2534LogicalConnectResult extends J2534ErrorResult {
  phyChannelId: number
  channelId: number
}

export interface ConnectParams {
  connectFlags?: number
  flags?: number
  protocolId?: number
  protocol?: number
  baudRate?: number
  baud?: number
  pinSelect?: number
}

export interface WriteMsg {
  handle?: number
  txFlags?: number
  data: Buffer | string | number[]
}

export interface FilterParams {
  type: number
  localTxFlags?: number
  remoteTxFlags?: number
  mask: Buffer | string | number
  pattern: Buffer | string | number
  flowControl?: Buffer | string | number
  exp?: number
  argument?: Buffer | string | number
}

export class DFirstJ2534Error extends Error {
  code: number
  source: string
}

export class J2534Protocol {
  open(): Promise<J2534OpenResult>
  close(): Promise<J2534ErrorResult>
  connect(opts: ConnectParams): Promise<J2534ChannelResult>
  disconnect(channelId: number): Promise<J2534ChannelResult>
  readMsg(channelId: number, opts?: { msgNum?: number; num?: number; timeout?: number }): Promise<J2534ReadResult>
  writeMsg(channelId: number, msgs: WriteMsg | WriteMsg[]): Promise<J2534WriteResult>
  startPeriodicMsg(channelId: number, msg: { interval: number; handle?: number; data: WriteMsg['data']; txFlags?: number }): Promise<J2534IdResult>
  stopPeriodicMsg(channelId: number, msgId: number): Promise<J2534ChannelResult>
  startMsgFilter(channelId: number, filter: FilterParams): Promise<J2534IdResult>
  stopMsgFilter(channelId: number, filterId: number): Promise<J2534ChannelResult>
  readVersion(): Promise<J2534OpenResult>
  ioctl(channelId: number, ioctlId: number, input?: Buffer | string | number[], timeout?: number): Promise<J2534IoctlResult>
  logicalConnect(phyChannelId: number, opts: ConnectParams & { localTxFlags?: number; remoteTxFlags?: number; localAddress?: Buffer; remoteAddress?: Buffer }): Promise<J2534LogicalConnectResult>
  logicalDisconnect(channelId: number): Promise<J2534ChannelResult>
  customFeature(featureId: number, input?: Buffer | string | number[], timeout?: number): Promise<J2534IoctlResult>
  exec(payload: Buffer, timeout?: number): Promise<{ error: number; commandId: number; raw: Buffer }>
}

export class PassThruChannel {
  id: number
  physical: boolean
  protocol?: number
  disconnect(): Promise<void>
  writeMsgs(msgs: WriteMsg | WriteMsg[]): Promise<J2534WriteResult>
  readMsgs(options?: { num?: number; timeout?: number }): Promise<J2534Message[]>
  startMsgFilter(filter: FilterParams): Promise<number>
  stopMsgFilter(filterId: number): Promise<void>
  ioctl(ioctlId: number, input?: Buffer | string | number[], timeout?: number): Promise<J2534IoctlResult>
  setConfig(items: { paramId?: number; index?: number; value: number }[]): Promise<J2534IoctlResult>
  addFunctLookup(addrs: number | number[]): Promise<J2534IoctlResult>
  clearFunctLookup(): Promise<J2534IoctlResult>
  fiveBaudInit(addr: number, opts?: { fiveBaudMod?: number; timeout?: number }): Promise<J2534IoctlResult & { kb1: number; kb2: number }>
  fastInit(msg?: Buffer | string | number[], opts?: { timeout?: number }): Promise<J2534IoctlResult>
  connectLogical(opts: object): Promise<PassThruChannel>
}

export class DFirstJ2534 {
  constructor(options?: {
    transport?: 'lan' | 'ble'
    host?: string
    port?: number
    timeout?: number
    name?: string
    deviceId?: string
    blecfg?: string
    namePrefix?: string
    /** 强制 J2534 线协议版本；默认按机型自动选择 */
    proVersion?: 'V1' | 'V2'
  })
  readonly j2534: J2534Protocol
  readonly transport: 'lan' | 'ble'
  /** 当前编解码版本（OPEN 后可能按设备回报校正） */
  readonly proVersion: 'V1' | 'V2'
  /** 机型码如 S2 / A2，来自名称或 PSN */
  deviceCode: string
  readonly codec: ReturnType<typeof createCodec>
  info: { psn?: string; name?: string; appVersion?: string; hwVersion?: string; bootVersion?: string; raw?: string } | null
  static scanBle(opts?: { namePrefix?: string; timeout?: number }): Promise<{ id: string; name: string; rssi: number }[]>
  /** DNS-SD `_rdcomm._tcp.local` (Bonjour-compatible). */
  static scanLan(opts?: { timeout?: number; name?: string; interface?: string }): Promise<{
    id: string
    name: string
    host: string
    port: number
    hostname?: string
    psn?: string
    txt?: Record<string, string>
    transport: 'lan'
  }[]>
  connect(target?: object | string): Promise<DFirstJ2534['info']>
  disconnect(): Promise<void>
  sendJ2534(payload: Buffer, timeout?: number): Promise<Buffer>
  passThruOpen(): Promise<string>
  passThruClose(): Promise<void>
  passThruConnect(opts: ConnectParams): Promise<PassThruChannel>
  passThruDisconnect(channel: number | PassThruChannel): Promise<void>
  passThruConnectLogical(phyChannel: number | PassThruChannel, opts: object): Promise<PassThruChannel>
  passThruReadMsgs(channel: number | PassThruChannel, options?: { num?: number; timeout?: number }): Promise<J2534Message[]>
  passThruWriteMsgs(channel: number | PassThruChannel, msgs: WriteMsg | WriteMsg[]): Promise<J2534WriteResult>
  passThruIoctl(channel: number | PassThruChannel, ioctlId: number, input?: Buffer | string | number[], timeout?: number): Promise<J2534IoctlResult>
  passThruSetConfig(channel: number | PassThruChannel, items: { paramId?: number; index?: number; value: number }[]): Promise<J2534IoctlResult>
  readPinVoltage(pin: number): Promise<number>
  wifiGetState(timeout?: number): Promise<{ raw: string; state: number | null; ssid: string; label: string }>
  wifiScan(timeout?: number): Promise<{ ssid: string; ecn: number; rssi: number }[]>
  wifiConnect(ssid: string, password: string, timeout?: number): Promise<{ ssid: string }>
  wifiDisconnect(timeout?: number): Promise<{ ok: true }>
  upgradeFirmware(bin: Buffer | Uint8Array, opts?: {
    reboot?: boolean
    chunkSize?: number
    eraseTimeout?: number
    programTimeout?: number
    onProgress?: (p: { phase: string; percent: number; msg?: string }) => void
  }): Promise<{ ok: true; size: number; rebooted: boolean }>
  openIso15765(opts?: object): Promise<PassThruChannel>
  loadJsonConfig(config: object | string, configId?: number): Promise<number>
  clearConfig(): Promise<void>
  on(event: 'message' | 'connected' | 'close' | 'error' | 'event', listener: (...args: any[]) => void): this
}

export const encode: Record<string, (...args: any[]) => Buffer>
export const decode: Record<string, (buf: Buffer) => object>
export function createCodec(proVersion?: 'V1' | 'V2' | string): {
  proVersion: 'V1' | 'V2'
  isV2: boolean
  encode: typeof encode
  decode: typeof decode
  [key: string]: any
}
export const V2_DEVICE_CODES: readonly string[]
export const V1_DEVICE_CODES: readonly string[]
export function deviceCodeFromName(nameOrPsn?: string): string
export function inferProVersion(opts?: {
  name?: string
  psn?: string
  deviceCode?: string
  openVersion?: string
  override?: string
}): 'V1' | 'V2'
export function normalizeProVersion(v?: string): string
export function parseOpenVersionString(versionStr?: string): {
  soft?: string
  hard?: string
  sn?: string
  boot?: string
  proVersion?: string
  raw: string
}
export function openVersionTryOrder(preferred?: string): ('V1' | 'V2')[]
