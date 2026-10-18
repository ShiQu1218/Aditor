import { createHash } from 'crypto'

// 測試只使用既有依賴樹的 ws 與 MessagePack，沒有新增正式依賴。
const { WebSocketServer } = require('ws')
const { encode, decode } = require('@msgpack/msgpack')
const hash = (value: string): string => createHash('sha256').update(value).digest('base64')

export async function fakeObs(options: { password?: string; recording?: boolean; outputPath?: string; duration?: number; stall?: 'hello' | 'request' } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  let recording = options.recording ?? false
  const calls: string[] = []
  const sockets = new Set<any>()
  const send = (socket: any, value: object): void => socket.send(socket.protocol === 'obswebsocket.msgpack' ? encode(value) : JSON.stringify(value))
  const event = (outputState: string): void => {
    recording = outputState !== 'OBS_WEBSOCKET_OUTPUT_STOPPED'
    for (const socket of sockets) send(socket, { op: 5, d: { eventType: 'RecordStateChanged', eventIntent: 64,
      eventData: { outputState, outputActive: recording, outputPath: options.outputPath ?? '' } } })
  }
  server.on('connection', (socket: any) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    if (options.stall === 'hello') return
    send(socket, { op: 0, d: { obsWebSocketVersion: '5.5.0', rpcVersion: 1,
      ...(options.password ? { authentication: { salt: 'salt', challenge: 'challenge' } } : {}) } })
    socket.on('message', (data: Buffer) => {
      const msg = socket.protocol === 'obswebsocket.msgpack' ? decode(data) : JSON.parse(data.toString())
      if (msg.op === 1) {
        if (options.password && msg.d.authentication !== hash(hash(options.password + 'salt') + 'challenge')) {
          socket.close(4009, 'Authentication failed'); return
        }
        send(socket, { op: 2, d: { negotiatedRpcVersion: 1 } }); return
      }
      if (msg.op !== 6) return
      const { requestType, requestId } = msg.d
      calls.push(requestType)
      if (options.stall === 'request') return
      let responseData: object = {}
      if (requestType === 'GetVersion') responseData = { obsVersion: '31.0.0', obsWebSocketVersion: '5.5.0' }
      if (requestType === 'GetRecordStatus') responseData = { outputActive: recording, outputDuration: options.duration ?? 10000 }
      if (requestType === 'StartRecord') event('OBS_WEBSOCKET_OUTPUT_STARTED')
      if (requestType === 'StopRecord') { event('OBS_WEBSOCKET_OUTPUT_STOPPED'); responseData = { outputPath: options.outputPath ?? '' } }
      send(socket, { op: 7, d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData } })
    })
  })
  return {
    port: server.address().port as number, calls, event,
    disconnect: () => { for (const socket of sockets) socket.terminate() },
    setRecording: (value: boolean) => { recording = value },
    close: async () => {
      for (const socket of sockets) socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
