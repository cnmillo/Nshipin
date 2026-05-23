import { randomUUID } from 'crypto'
import WebSocket from 'isomorphic-ws'
import { OUTPUT_FORMAT } from 'edge-tts-node'
import { generateSecMSGecParam } from 'edge-tts-node/dist/SecMSGec.js'
import type { TTSProviderAdapter, AIConfig, ProviderRequest } from './types'

const CHROMIUM_VERSION = '143'
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const BINARY_DELIM = Buffer.from('Path:audio\r\n')

const WSS_HEADERS = {
  'Pragma': 'no-cache',
  'Cache-Control': 'no-cache',
  'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_VERSION}.0.0.0`,
  'Accept-Encoding': 'gzip, deflate, br',
  'Accept-Language': 'en-US,en;q=0.9',
}

function getSynthUrl(): string {
  const param = generateSecMSGecParam(TRUSTED_CLIENT_TOKEN)
  return `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}${param}`.replace(/1-130\.0\.2849\.68/, `1-${CHROMIUM_VERSION}.0.2849.68`)
}

function synthesize(text: string, voice: string, rate?: string, pitch?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const voiceLocale = voice.match(/\w{2}-\w{2}/)?.[0] || 'zh-CN'
    const url = getSynthUrl()
    const ws = new WebSocket(url, { headers: WSS_HEADERS } as any)

    const audioChunks: Buffer[] = []
    let settled = false

    function done(err?: Error) {
      if (settled) return
      settled = true
      try { ws.close() } catch {}
      if (err) return reject(err)
      const total = Buffer.concat(audioChunks)
      if (total.length === 0) return reject(new Error('未收到音频数据'))
      resolve(total)
    }

    ws.on('open', () => {
      const configMsg = `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3}"}}}}`
      ws.send(configMsg)

      const requestId = randomUUID().replace(/-/g, '')
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${voiceLocale}'><voice name='${voice}'><prosody rate='${rate || '+0%'}' pitch='${pitch || '+0Hz'}'>${text}</prosody></voice></speak>`
      const ssmlMsg = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`
      ws.send(ssmlMsg)
    })

    ws.on('message', (raw: any) => {
      const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)

      if (data.length < 2) return

      const headerLength = data.readUInt16BE(0)

      if (headerLength === 0 || headerLength > data.length - 2) {
        const text = data.toString('utf8')
        if (text.includes('Path:turn.end')) done()
        return
      }

      const headerStr = data.subarray(2, headerLength + 2).toString('utf8')

      if (headerStr.includes('Path:audio')) {
        const delimIdx = data.indexOf(BINARY_DELIM)
        if (delimIdx >= 0) {
          const audioData = data.subarray(delimIdx + BINARY_DELIM.length)
          if (audioData.length > 0) audioChunks.push(audioData)
        } else {
          const audioData = data.subarray(headerLength + 2)
          if (audioData.length > 0) audioChunks.push(audioData)
        }
      } else if (headerStr.includes('Path:turn.end')) {
        done()
      }
    })

    ws.on('error', (err: Error) => {
      done(new Error(`Edge TTS WebSocket error: ${err.message}`))
    })

    ws.on('close', () => {
      done()
    })

    setTimeout(() => {
      done(new Error('Edge TTS 超时（30秒）'))
    }, 30000)
  })
}

export class EdgeTTSAdapter implements TTSProviderAdapter {
  readonly provider = 'edge-tts'

  buildGenerateRequest(_config: AIConfig, _params: any): ProviderRequest {
    throw new Error('Edge TTS uses generateDirect, not HTTP request')
  }

  parseResponse(_result: any): {
    audioHex: string
    audioLength: number
    sampleRate: number
    bitrate: number
    format: string
    channel: number
  } {
    throw new Error('Edge TTS uses generateDirect, not HTTP response parsing')
  }

  async generateDirect(params: any): Promise<{ buffer: Buffer; format: string }> {
    const voice = params.voice || 'zh-CN-XiaoxiaoNeural'
    const rate = params.speed ? `${params.speed > 1 ? '+' : ''}${Math.round((params.speed - 1) * 100)}%` : '+0%'
    const pitch = params.pitch || '+0Hz'
    const buffer = await synthesize(params.text, voice, rate, pitch)
    return { buffer, format: 'mp3' }
  }
}
