import type { TTSProviderAdapter, AIConfig, ProviderRequest } from './types'
import { joinProviderUrl } from './url'

export interface CosyVoiceTTSParams {
  text: string
  voice: string
  speed?: number
  model?: string
  emotion?: string
  promptAudio?: string
  promptText?: string
}

export class CosyVoiceTTSAdapter implements TTSProviderAdapter {
  readonly provider = 'cosyvoice'

  buildGenerateRequest(config: AIConfig, params: CosyVoiceTTSParams): ProviderRequest {
    const url = joinProviderUrl(config.baseUrl, '', '/inference')

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`
    }

    const voiceParts = params.voice.split(':')
    const mode = voiceParts[0] || 'sft'
    const spkId = voiceParts.slice(1).join(':') || ''

    const body: any = {
      tts_text: params.text,
      mode,
      stream: false,
    }

    if (mode === 'sft') {
      body.spk_id = spkId || '中文女'
    } else if (mode === 'zero_shot') {
      body.prompt_text = params.promptText || ''
      body.prompt_wav = params.promptAudio || ''
    } else if (mode === 'cross_lingual') {
      body.prompt_wav = params.promptAudio || ''
    } else if (mode === 'instruct') {
      body.spk_id = spkId || '中文女'
      body.instruct_text = params.emotion || '用自然的语气说话'
    }

    if (params.speed && params.speed !== 1) {
      body.speed = params.speed
    }

    return { url, method: 'POST', headers, body, expectBinary: true }
  }

  parseResponse(_result: any): {
    audioHex: string
    audioLength: number
    sampleRate: number
    bitrate: number
    format: string
    channel: number
  } {
    throw new Error('CosyVoice TTS returns binary audio, use expectBinary instead')
  }

  async generateDirect(params: any): Promise<{ buffer: Buffer; format: string }> {
    const config: AIConfig = params.config || {
      provider: 'cosyvoice',
      baseUrl: params.baseUrl || 'http://cosyvoice:50000',
      apiKey: '',
      model: '',
    }

    const req = this.buildGenerateRequest(config, params)

    const resp = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify(req.body),
    })

    if (!resp.ok) {
      const errText = await resp.text()
      throw new Error(`CosyVoice TTS error ${resp.status}: ${errText}`)
    }

    const contentType = resp.headers.get('content-type') || ''
    let format = 'wav'

    if (contentType.includes('audio/wav') || contentType.includes('audio/x-wav')) {
      format = 'wav'
    } else if (contentType.includes('audio/mp3') || contentType.includes('audio/mpeg')) {
      format = 'mp3'
    } else if (contentType.includes('audio/pcm')) {
      format = 'pcm'
    }

    const arrayBuf = await resp.arrayBuffer()
    const buffer = Buffer.from(arrayBuf)

    if (buffer.length === 0) {
      throw new Error('CosyVoice TTS 返回空音频数据')
    }

    return { buffer, format }
  }
}
