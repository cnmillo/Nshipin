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

const EMOTION_INSTRUCT_MAP: Record<string, string> = {
  '愤怒': '用愤怒的语气说话，声音有力，语速偏快，咬字重',
  '生气': '用生气的语气说话，声音有力，语速偏快',
  '咆哮': '用咆哮的语气说话，声音极大，充满怒火',
  '怒吼': '用怒吼的语气说话，声音极大，充满怒火',
  '大喊': '用大声喊叫的语气说话，声音洪亮有力',
  '尖叫': '用尖叫的语气说话，声音高亢刺耳',
  '悲伤': '用悲伤的语气说话，声音低沉，语速缓慢，带着哭腔',
  '哭泣': '用哭泣的语气说话，声音颤抖，带着哭腔和抽泣',
  '哭诉': '用哭诉的语气说话，声音颤抖，带着委屈和悲伤',
  '哽咽': '用哽咽的语气说话，声音断断续续，压抑着悲伤',
  '抽泣': '用抽泣的语气说话，声音断断续续，带着哭腔',
  '开心': '用开心的语气说话，声音明亮，语速轻快，带着笑意',
  '高兴': '用高兴的语气说话，声音明亮，语速轻快',
  '兴奋': '用兴奋的语气说话，声音高亢，语速快，充满激情',
  '激动': '用激动的语气说话，声音高亢，语速快，充满激情',
  '欢笑': '用欢笑的语气说话，声音明亮，带着笑意',
  '大笑': '用大笑的语气说话，声音爽朗，充满快乐',
  '恐惧': '用恐惧的语气说话，声音颤抖，语速不均匀，带着害怕',
  '害怕': '用害怕的语气说话，声音颤抖，语速不均匀',
  '惊恐': '用惊恐的语气说话，声音颤抖，语速极快，极度害怕',
  '紧张': '用紧张的语气说话，语速偏快，声音略微颤抖',
  '焦虑': '用焦虑的语气说话，语速偏快，声音不安',
  '温柔': '用温柔的语气说话，声音轻柔，语速缓慢，充满关爱',
  '轻声': '用轻声细语的语气说话，声音很小，语速缓慢',
  '低语': '用低语的方式说话，声音极轻，像在耳边呢喃',
  '耳语': '用耳语的方式说话，声音极轻，像在耳边呢喃',
  '冷漠': '用冷漠的语气说话，声音平淡，没有感情起伏',
  '冷淡': '用冷淡的语气说话，声音平淡，没有感情起伏',
  '平静': '用平静的语气说话，声音平稳，语速适中',
  '沉思': '用沉思的语气说话，声音低沉，语速缓慢，像在思考',
  '犹豫': '用犹豫的语气说话，语速不均匀，带着迟疑',
  '坚定': '用坚定的语气说话，声音有力，语速稳定，充满决心',
  '果断': '用果断的语气说话，声音有力，语速稳定，毫不犹豫',
  '惊讶': '用惊讶的语气说话，声音突然升高，语速先快后慢',
  '震惊': '用震惊的语气说话，声音突然升高，带着难以置信',
  '嘲讽': '用嘲讽的语气说话，声音带着轻蔑和讽刺',
  '讽刺': '用讽刺的语气说话，声音带着轻蔑和挖苦',
  '撒娇': '用撒娇的语气说话，声音甜美，语速偏慢，带着娇嗔',
  '委屈': '用委屈的语气说话，声音低沉，带着哭腔和不满',
  '疲惫': '用疲惫的语气说话，声音低沉，语速缓慢，没有力气',
  '叹息': '用叹息的语气说话，声音低沉，带着无奈和疲惫',
  '叹气': '用叹气的语气说话，声音低沉，带着无奈',
  '急切': '用急切的语气说话，语速很快，充满紧迫感',
  '催促': '用催促的语气说话，语速很快，充满紧迫感',
  '警告': '用警告的语气说话，声音低沉有力，语速偏慢，充满威慑',
  '威胁': '用威胁的语气说话，声音低沉有力，充满威慑',
  '安慰': '用安慰的语气说话，声音温柔，语速缓慢，充满关爱',
  '鼓励': '用鼓励的语气说话，声音明亮，语速适中，充满力量',
  '感激': '用感激的语气说话，声音温暖，带着真诚的感谢',
  '道歉': '用道歉的语气说话，声音低沉，语速偏慢，带着歉意',
  '无奈': '用无奈的语气说话，声音低沉，语速偏慢，带着叹息',
  '轻蔑': '用轻蔑的语气说话，声音冷淡，带着不屑',
  '不屑': '用不屑的语气说话，声音冷淡，带着轻蔑',
  '得意': '用得意的语气说话，声音明亮，语速偏快，充满自信',
  '骄傲': '用骄傲的语气说话，声音明亮，充满自豪',
  '害羞': '用害羞的语气说话，声音很小，语速偏慢，带着羞涩',
  '尴尬': '用尴尬的语气说话，声音不自然，语速不均匀',
  '痛苦': '用痛苦的语气说话，声音低沉，带着呻吟',
  '呻吟': '用呻吟的语气说话，声音低沉，带着痛苦',
  '喘息': '用喘息的语气说话，声音急促，带着疲惫',
}

function getEmotionInstruct(emotion?: string | null): string {
  if (!emotion) return '用自然的语气说话'
  return EMOTION_INSTRUCT_MAP[emotion] || `用${emotion}的语气说话`
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
      body.instruct_text = getEmotionInstruct(params.emotion)
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
