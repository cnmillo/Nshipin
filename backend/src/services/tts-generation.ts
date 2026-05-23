/**
 * TTS 语音合成服务
 * 支持 MiniMax TTS (hex 音频响应) 和 OpenAI 兼容 /audio/speech
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import { getAudioConfigById, getActiveConfig } from './ai.js'
import { getTTSAdapter } from './adapters/registry.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')

function isEdgeTTSVoice(voice: string): boolean {
  return voice.match(/^zh-/) !== null
}

const VOICE_TO_EDGE: Record<string, string> = {
  alloy: 'zh-CN-XiaoxiaoNeural',
  echo: 'zh-CN-YunjianNeural',
  fable: 'zh-CN-YunxiNeural',
  onyx: 'zh-CN-YunjianNeural',
  nova: 'zh-CN-XiaoyiNeural',
  shimmer: 'zh-CN-XiaoyiNeural',
  '温柔女声': 'zh-CN-XiaoxiaoNeural',
  '甜美女声': 'zh-CN-XiaoyiNeural',
  '稳重男声': 'zh-CN-YunjianNeural',
  '清朗男声': 'zh-CN-YunxiNeural',
  '少年男声': 'zh-CN-YunxiaNeural',
  '新闻男声': 'zh-CN-YunyangNeural',
  '东北话女声': 'zh-CN-liaoning-XiaobeiNeural',
  '陕西话女声': 'zh-CN-shaanxi-XiaoniNeural',
  '粤语女声': 'zh-HK-HiuGaaiNeural',
  '粤语男声': 'zh-HK-WanLungNeural',
  '台湾女声': 'zh-TW-HsiaoChenNeural',
  '台湾男声': 'zh-TW-YunJheNeural',
}

function mapToEdgeVoice(voice: string): string {
  if (isEdgeTTSVoice(voice)) return voice
  return VOICE_TO_EDGE[voice] || 'zh-CN-XiaoxiaoNeural'
}

interface TTSParams {
  text: string
  voice: string
  model?: string
  speed?: number
  emotion?: string
  configId?: number | null
  voiceProvider?: string | null
}

/**
 * 生成 TTS 音频，返回本地文件路径
 */
export async function generateTTS(params: TTSParams): Promise<string> {
  let config = getAudioConfigById(params.configId)

  // 自动检测 Edge TTS 音色
  const isEdgeVoice = isEdgeTTSVoice(params.voice)
  if (isEdgeVoice && config.provider !== 'edge-tts') {
    // 尝试获取 Edge TTS 配置
    const edgeConfig = getActiveConfig('audio')
    if (edgeConfig && edgeConfig.provider === 'edge-tts') {
      logTaskWarn('AudioTask', 'auto-switch-to-edge', {
        voice: params.voice,
        oldProvider: config.provider,
        newProvider: 'edge-tts'
      })
      config = edgeConfig
    } else if (params.voiceProvider === 'edge-tts') {
      logTaskWarn('AudioTask', 'force-edge-no-config', { voice: params.voice })
      // 直接使用 Edge TTS（不需要完整配置）
      config = {
        provider: 'edge-tts',
        baseUrl: '',
        apiKey: '',
        model: '',
      }
    }
  } else if (params.voiceProvider === 'edge-tts') {
    config = {
      provider: 'edge-tts',
      baseUrl: '',
      apiKey: '',
      model: '',
    }
  }

  // 当配置是 Edge TTS 但音色无效时，自动替换为默认音色
  let effectiveVoice = params.voice
  if (config.provider === 'edge-tts' && !isEdgeTTSVoice(params.voice)) {
    effectiveVoice = mapToEdgeVoice(params.voice)
    logTaskWarn('AudioTask', 'auto-map-voice', {
      originalVoice: params.voice,
      mappedVoice: effectiveVoice,
      reason: 'Edge TTS 配置下自动映射音色'
    })
  }

  const adapter = getTTSAdapter(config.provider)

  logTaskStart('AudioTask', 'tts-generate', {
    provider: config.provider,
    voice: effectiveVoice,
    model: params.model || config.model,
    textPreview: params.text.slice(0, 50),
    textLength: params.text.length,
  })

  const audioDir = path.join(STORAGE_ROOT, 'audio')
  fs.mkdirSync(audioDir, { recursive: true })

  let buffer: Buffer
  let format = 'mp3'

  if (adapter.generateDirect) {
    logTaskProgress('AudioTask', 'generate-direct', { provider: config.provider, voice: effectiveVoice })
    const result = await adapter.generateDirect({ ...params, voice: effectiveVoice })
    buffer = result.buffer
    format = result.format || 'mp3'
  } else {
    const req = adapter.buildGenerateRequest(config, { ...params, voice: effectiveVoice })
    const isBinary = req.expectBinary === true
    logTaskProgress('AudioTask', 'request', {
      provider: config.provider,
      voice: effectiveVoice,
      method: req.method,
      url: redactUrl(req.url),
      model: params.model || config.model,
    })
    logTaskPayload('AudioTask', 'request payload', {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: req.body,
    })

    const resp = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify(req.body),
    })

    if (!resp.ok) {
      const errText = await resp.text()
      logTaskError('AudioTask', 'tts-generate', { provider: config.provider, voice: effectiveVoice, status: resp.status, error: errText })
      throw new Error(`TTS API error ${resp.status}: ${errText}`)
    }

    if (isBinary) {
      const arrayBuf = await resp.arrayBuffer()
      buffer = Buffer.from(arrayBuf)
    } else {
      const result = await resp.json()
      const parsed = adapter.parseResponse(result)
      buffer = Buffer.from(parsed.audioHex, 'hex')
      format = parsed.format || 'mp3'
    }
  }

  const filename = `${uuid()}.${format}`
  const filePath = path.join(audioDir, filename)
  fs.writeFileSync(filePath, buffer)

  const relativePath = `static/audio/${filename}`
  logTaskSuccess('AudioTask', 'tts-saved', {
    provider: config.provider,
    voice: effectiveVoice,
    path: relativePath,
    bytes: buffer.length,
  })
  return relativePath
}

/**
 * 为角色生成试听音频
 */
export async function generateVoiceSample(
  characterName: string,
  voiceId: string,
  configId?: number | null,
  voiceProvider?: string | null
): Promise<string> {
  const sampleText = `你好，我是${characterName}。很高兴认识你，这是我的声音试听。`
  return generateTTS({ text: sampleText, voice: voiceId, configId, voiceProvider })
}
