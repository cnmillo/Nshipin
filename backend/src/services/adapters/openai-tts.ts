import type { TTSProviderAdapter } from './types'
import { joinProviderUrl } from './url'

export interface TTSParams {
  text: string
  voice: string
  speed?: number
  model?: string
  emotion?: string
}

export interface TTSResult {
  audioHex: string
  audioLength: number
  sampleRate: number
  bitrate: number
  format: string
  channel: number
}

export class OpenAITTSAdapter implements TTSProviderAdapter {
  readonly provider = 'openai'

  buildGenerateRequest(config: any, params: TTSParams): {
    url: string
    method: string
    headers: Record<string, string>
    body: any
    expectBinary: boolean
  } {
    const url = joinProviderUrl(config.baseUrl, '/v1', '/audio/speech')

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    }

    const body: any = {
      model: params.model || config.model || 'tts-1',
      input: params.text,
      voice: params.voice,
      speed: params.speed ?? 1,
      response_format: 'mp3',
    }

    return { url, method: 'POST', headers, body, expectBinary: true }
  }

  parseResponse(result: any): TTSResult {
    throw new Error('OpenAI TTS returns binary audio, use parseBinaryResponse instead')
  }
}
