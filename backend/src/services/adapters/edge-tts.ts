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

export interface WordBoundary {
  text: string
  offsetMs: number
  durationMs: number
}

export interface EdgeTTSResult {
  buffer: Buffer
  format: string
  wordBoundaries: WordBoundary[]
  audioDurationMs: number
}

export interface EmotionProsody {
  rate: string
  pitch: string
  volume: string
}

const EMOTION_PROSODY_MAP: Record<string, EmotionProsody> = {
  '愤怒': { rate: '+15%', pitch: '+5Hz', volume: '+30%' },
  '生气': { rate: '+15%', pitch: '+5Hz', volume: '+30%' },
  '咆哮': { rate: '+20%', pitch: '+8Hz', volume: '+40%' },
  '怒吼': { rate: '+20%', pitch: '+8Hz', volume: '+40%' },
  '大喊': { rate: '+15%', pitch: '+5Hz', volume: '+35%' },
  '尖叫': { rate: '+25%', pitch: '+12Hz', volume: '+40%' },
  '悲伤': { rate: '-10%', pitch: '-3Hz', volume: '-15%' },
  '哭泣': { rate: '-15%', pitch: '-5Hz', volume: '-20%' },
  '哭诉': { rate: '-15%', pitch: '-5Hz', volume: '-20%' },
  '哽咽': { rate: '-20%', pitch: '-5Hz', volume: '-25%' },
  '抽泣': { rate: '-20%', pitch: '-5Hz', volume: '-25%' },
  '开心': { rate: '+10%', pitch: '+3Hz', volume: '+10%' },
  '高兴': { rate: '+10%', pitch: '+3Hz', volume: '+10%' },
  '兴奋': { rate: '+15%', pitch: '+5Hz', volume: '+15%' },
  '激动': { rate: '+15%', pitch: '+5Hz', volume: '+15%' },
  '欢笑': { rate: '+10%', pitch: '+4Hz', volume: '+15%' },
  '大笑': { rate: '+10%', pitch: '+4Hz', volume: '+20%' },
  '恐惧': { rate: '+10%', pitch: '+3Hz', volume: '-5%' },
  '害怕': { rate: '+10%', pitch: '+3Hz', volume: '-5%' },
  '惊恐': { rate: '+15%', pitch: '+5Hz', volume: '-10%' },
  '紧张': { rate: '+10%', pitch: '+2Hz', volume: '-5%' },
  '焦虑': { rate: '+10%', pitch: '+2Hz', volume: '-5%' },
  '温柔': { rate: '-5%', pitch: '-2Hz', volume: '-10%' },
  '轻声': { rate: '-10%', pitch: '-2Hz', volume: '-20%' },
  '低语': { rate: '-10%', pitch: '-2Hz', volume: '-25%' },
  '耳语': { rate: '-15%', pitch: '-3Hz', volume: '-30%' },
  '冷漠': { rate: '-5%', pitch: '-2Hz', volume: '-15%' },
  '冷淡': { rate: '-5%', pitch: '-2Hz', volume: '-15%' },
  '平静': { rate: '+0%', pitch: '+0Hz', volume: '+0%' },
  '沉思': { rate: '-10%', pitch: '-2Hz', volume: '-10%' },
  '犹豫': { rate: '-10%', pitch: '-1Hz', volume: '-10%' },
  '坚定': { rate: '+5%', pitch: '+2Hz', volume: '+10%' },
  '果断': { rate: '+5%', pitch: '+2Hz', volume: '+10%' },
  '惊讶': { rate: '+10%', pitch: '+5Hz', volume: '+5%' },
  '震惊': { rate: '+15%', pitch: '+8Hz', volume: '+10%' },
  '嘲讽': { rate: '+5%', pitch: '+2Hz', volume: '+0%' },
  '讽刺': { rate: '+5%', pitch: '+2Hz', volume: '+0%' },
  '撒娇': { rate: '+5%', pitch: '+3Hz', volume: '-5%' },
  '委屈': { rate: '-5%', pitch: '-3Hz', volume: '-10%' },
  '疲惫': { rate: '-15%', pitch: '-3Hz', volume: '-15%' },
  '叹息': { rate: '-15%', pitch: '-3Hz', volume: '-15%' },
  '叹气': { rate: '-15%', pitch: '-3Hz', volume: '-15%' },
  '急切': { rate: '+15%', pitch: '+3Hz', volume: '+10%' },
  '催促': { rate: '+15%', pitch: '+3Hz', volume: '+10%' },
  '警告': { rate: '+5%', pitch: '+2Hz', volume: '+15%' },
  '威胁': { rate: '+5%', pitch: '+2Hz', volume: '+15%' },
  '安慰': { rate: '-5%', pitch: '-2Hz', volume: '-10%' },
  '鼓励': { rate: '+5%', pitch: '+2Hz', volume: '+5%' },
  '感激': { rate: '+5%', pitch: '+2Hz', volume: '+5%' },
  '道歉': { rate: '-5%', pitch: '-2Hz', volume: '-10%' },
  '无奈': { rate: '-10%', pitch: '-2Hz', volume: '-10%' },
  '轻蔑': { rate: '+0%', pitch: '-1Hz', volume: '-5%' },
  '不屑': { rate: '+0%', pitch: '-1Hz', volume: '-5%' },
  '得意': { rate: '+10%', pitch: '+3Hz', volume: '+10%' },
  '骄傲': { rate: '+10%', pitch: '+3Hz', volume: '+10%' },
  '害羞': { rate: '-5%', pitch: '+1Hz', volume: '-15%' },
  '尴尬': { rate: '-5%', pitch: '-1Hz', volume: '-10%' },
  '痛苦': { rate: '-5%', pitch: '-3Hz', volume: '-10%' },
  '呻吟': { rate: '-15%', pitch: '-5Hz', volume: '-20%' },
  '喘息': { rate: '-10%', pitch: '-2Hz', volume: '-15%' },
}

export function getEmotionProsody(emotion: string): EmotionProsody | null {
  return EMOTION_PROSODY_MAP[emotion] || null
}

export function resolveProsody(emotion?: string | null, baseRate?: string, basePitch?: string): { rate: string; pitch: string; volume: string } {
  const base = { rate: baseRate || '+0%', pitch: basePitch || '+0Hz', volume: '+0%' }
  if (!emotion) return base
  const prosody = getEmotionProsody(emotion)
  if (!prosody) return base
  return prosody
}

function getSynthUrl(): string {
  const param = generateSecMSGecParam(TRUSTED_CLIENT_TOKEN)
  return `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}${param}`.replace(/1-130\.0\.2849\.68/, `1-${CHROMIUM_VERSION}.0.2849.68`)
}

function synthesize(text: string, voice: string, rate?: string, pitch?: string, volume?: string): Promise<EdgeTTSResult> {
  return new Promise((resolve, reject) => {
    const voiceLocale = voice.match(/\w{2}-\w{2}/)?.[0] || 'zh-CN'
    const url = getSynthUrl()
    const ws = new WebSocket(url, { headers: WSS_HEADERS } as any)

    const audioChunks: Buffer[] = []
    const wordBoundaries: WordBoundary[] = []
    let settled = false

    function done(err?: Error) {
      if (settled) return
      settled = true
      try { ws.close() } catch {}
      if (err) return reject(err)
      const total = Buffer.concat(audioChunks)
      if (total.length === 0) return reject(new Error('未收到音频数据'))

      let audioDurationMs = 0
      if (wordBoundaries.length > 0) {
        const last = wordBoundaries[wordBoundaries.length - 1]
        audioDurationMs = last.offsetMs + last.durationMs
      }

      resolve({ buffer: total, format: 'mp3', wordBoundaries, audioDurationMs })
    }

    ws.on('open', () => {
      const configMsg = `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"true"},"outputFormat":"${OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3}"}}}}`
      ws.send(configMsg)

      const requestId = randomUUID().replace(/-/g, '')
      const prosodyAttrs = `rate='${rate || '+0%'}' pitch='${pitch || '+0Hz'}' volume='${volume || '+0%'}'`
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${voiceLocale}'><voice name='${voice}'><prosody ${prosodyAttrs}>${text}</prosody></voice></speak>`
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
      } else if (headerStr.includes('Path:response')) {
        // skip
      } else {
        const textContent = data.subarray(2).toString('utf8')
        const boundaryMatch = textContent.match(/Path:word\.boundary/)
        if (boundaryMatch) {
          try {
            const jsonMatch = textContent.match(/\{[^}]+\}/g)
            if (jsonMatch) {
              for (const jsonStr of jsonMatch) {
                try {
                  const obj = JSON.parse(jsonStr)
                  if (obj.type === 'WordBoundary') {
                    const offsetMs = Math.round((obj.offset || 0) / 10000)
                    const durationMs = Math.round((obj.duration || 0) / 10000)
                    wordBoundaries.push({
                      text: obj.text || '',
                      offsetMs,
                      durationMs,
                    })
                  }
                } catch {}
              }
            }
          } catch {}
        }
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
    const prosody = resolveProsody(params.emotion, params.rate, params.pitch)
    const result = await synthesize(params.text, voice, prosody.rate, prosody.pitch, prosody.volume)
    return { buffer: result.buffer, format: result.format }
  }

  async generateDirectWithTimestamps(params: any): Promise<EdgeTTSResult> {
    const voice = params.voice || 'zh-CN-XiaoxiaoNeural'
    const prosody = resolveProsody(params.emotion, params.rate, params.pitch)
    return synthesize(params.text, voice, prosody.rate, prosody.pitch, prosody.volume)
  }
}
