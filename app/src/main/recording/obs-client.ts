import { OBSWebSocket } from 'obs-websocket-js'
import { EventEmitter } from 'events'
import { tr } from '../../shared/locale'

/** OBS v5 的小型介面：所有等候都有逾時，錯誤不包含密碼或伺服器回傳文字。 */
export class ObsClient extends EventEmitter {
  private socket: OBSWebSocket | null = null
  connected = false

  constructor(private timeoutMs = 3000) { super() }

  async connect(host: string, port: number, password?: string): Promise<void> {
    await this.close()
    const socket = new OBSWebSocket()
    this.socket = socket
    socket.on('ConnectionError', () => {})
    socket.on('ConnectionClosed', () => {
      if (this.socket !== socket) return
      this.connected = false
      this.emit('disconnected')
    })
    socket.on('RecordStateChanged', (event) => this.emit('record', event))
    const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    try {
      await this.deadline(socket.connect(`ws://${address}:${port}`, password, { rpcVersion: 1, eventSubscriptions: 64 }))
      this.connected = true
    } catch (error) {
      await this.close()
      throw new Error((error as { code?: number }).code === 4009 ? tr('OBS 密碼驗證失敗，請檢查密碼') : tr('無法連線 OBS，請確認 WebSocket 伺服器與主機、連接埠設定'))
    }
  }

  private async deadline<T>(promise: Promise<T>): Promise<T> {
    let timer!: ReturnType<typeof setTimeout>
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(tr('OBS 回應逾時'))), this.timeoutMs)
      })])
    } finally { clearTimeout(timer) }
  }

  private async call<T>(request: Promise<T>): Promise<T> {
    try { return await this.deadline(request) }
    catch { throw new Error(tr('OBS 指令失敗或回應逾時，請檢查 OBS 連線')) }
  }

  async version(): Promise<{ obsVersion: string; obsWebSocketVersion: string }> {
    const result = await this.call(this.socket!.call('GetVersion'))
    return { obsVersion: result.obsVersion, obsWebSocketVersion: result.obsWebSocketVersion }
  }
  status(): Promise<{ outputActive: boolean; outputDuration: number }> { return this.call(this.socket!.call('GetRecordStatus')) }
  async start(): Promise<void> { await this.call(this.socket!.call('StartRecord')) }
  async stop(): Promise<string> { return (await this.call(this.socket!.call('StopRecord'))).outputPath }

  async close(): Promise<void> {
    const socket = this.socket
    this.socket = null
    this.connected = false
    if (socket) await this.deadline(socket.disconnect()).catch(() => {})
  }
}
