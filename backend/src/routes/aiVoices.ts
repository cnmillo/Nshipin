/**
 * AI 音色管理
 * GET  /api/v1/ai-voices       - 获取音色列表
 * POST /api/v1/ai-voices/sync  - 从 MiniMax 同步音色
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { joinProviderUrl } from '../services/adapters/url.js'

const app = new Hono()

// GET /ai-voices?provider=minimax
app.get('/', async (c) => {
  const provider = c.req.query('provider') || 'minimax'
  const rows = db.select().from(schema.aiVoices)
    .where(eq(schema.aiVoices.provider, provider))
    .all()

  const parsed = rows.map(r => ({
    voice_id: r.voiceId,
    voice_name: r.voiceName,
    description: r.description ? JSON.parse(r.description) : [],
    language: r.language,
    provider: r.provider,
  }))

  return success(c, parsed)
})

// POST /ai-voices/sync
app.post('/sync', async (c) => {
  // 从数据库获取 minimax 的音频配置
  const rows = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, 'audio'))
    .all()
    .filter(r => r.isActive && r.provider === 'minimax')

  if (rows.length === 0) {
    return badRequest(c, 'No active minimax audio config found')
  }

  const config = rows[0]
  if (!config.apiKey) {
    return badRequest(c, 'MiniMax API key not configured')
  }

  // 调用 MiniMax get_voice API
  const resp = await fetch(joinProviderUrl(config.baseUrl, '/v1', '/get_voice'), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ voice_type: 'all' }),
  })

  if (!resp.ok) {
    return badRequest(c, `MiniMax API error: ${resp.status}`)
  }

  const result = await resp.json() as any
  if (result.base_resp?.status_code !== 0) {
    return badRequest(c, result.base_resp?.status_msg || 'Failed to fetch voices')
  }

  const voices = (result.system_voice || []).filter((v: any) => shouldKeepVoice(v))
  const ts = now()

  // 先清空旧数据
  db.delete(schema.aiVoices).where(eq(schema.aiVoices.provider, 'minimax')).run()

  // 批量插入新数据
  const insertRows = voices.map((v: any) => ({
    voiceId: v.voice_id,
    voiceName: v.voice_name,
    description: JSON.stringify(v.description || []),
    language: extractLanguage(v.voice_id, v.voice_name),
    provider: 'minimax',
    createdAt: ts,
  }))

  if (insertRows.length > 0) {
    db.insert(schema.aiVoices).values(insertRows).run()
  }

  return success(c, { count: insertRows.length, message: `Synced ${insertRows.length} voices` })
})

app.post('/sync-edge', async (c) => {
  try {
    const resp = await fetch('https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4', {
      headers: {
        'Authority': 'speech.platform.bing.com',
        'Sec-CH-UA': '" Not;A Brand";v="99", "Microsoft Edge";v="143", "Chromium";v="143"',
        'Sec-CH-UA-Mobile': '?0',
        'Accept': '*/*',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
      },
    })
    if (!resp.ok) return badRequest(c, `Edge TTS voices API error: ${resp.status}`)
    const allVoices = await resp.json() as any[]
    const voices = allVoices.filter((v: any) => v.Locale && v.Locale.startsWith('zh-'))
    const ts = now()

    db.delete(schema.aiVoices).where(eq(schema.aiVoices.provider, 'edge-tts')).run()

    const insertRows = voices.map((v: any) => ({
      voiceId: v.ShortName,
      voiceName: v.FriendlyName,
      description: JSON.stringify([v.Gender, v.Locale]),
      language: extractEdgeLanguage(v.Locale),
      provider: 'edge-tts',
      createdAt: ts,
    }))

    if (insertRows.length > 0) {
      db.insert(schema.aiVoices).values(insertRows).run()
    }

    return success(c, { count: insertRows.length, message: `Synced ${insertRows.length} edge-tts voices` })
  } catch (error: any) {
    return badRequest(c, error.message || 'Failed to sync edge-tts voices')
  }
})

/**
 * 从 voice_id 或 voice_name 推断语言
 */
function extractLanguage(voiceId: string, voiceName: string): string {
  const text = `${voiceId} ${voiceName}`.toLowerCase()
  if (text.includes('cantonese') || text.includes('粤')) return '粤语'
  if (text.includes('english') || text.includes('aussie')) return '英语'
  if (text.includes('japanese') || text.includes('日语')) return '日语'
  if (text.includes('korean') || text.includes('韩')) return '韩语'
  if (text.includes('spanish')) return '西班牙语'
  if (text.includes('portuguese')) return '葡萄牙语'
  if (text.includes('french')) return '法语'
  if (text.includes('indonesian')) return '印尼语'
  if (text.includes('german')) return '德语'
  if (text.includes('russian')) return '俄语'
  if (text.includes('italian')) return '意大利语'
  if (text.includes('arabic')) return '阿拉伯语'
  if (text.includes('turkish')) return '土耳其语'
  if (text.includes('ukrainian')) return '乌克兰语'
  if (text.includes('dutch')) return '荷兰语'
  if (text.includes('vietnamese')) return '越南语'
  if (text.includes('chinese') || text.includes('mandarin') || text.includes('中文')) return '中文'
  return '其他'
}

function extractEdgeLanguage(locale: string): string {
  if (locale === 'zh-CN') return '中文（普通话）'
  if (locale === 'zh-HK') return '粤语'
  if (locale === 'zh-TW') return '中文（台湾）'
  if (locale === 'zh-CN-liaoning') return '东北话'
  if (locale === 'zh-CN-shaanxi') return '陕西话'
  if (locale === 'zh-CN-shandong') return '山东话'
  if (locale === 'zh-CN-sichuan') return '四川话'
  if (locale.startsWith('zh-')) return '中文方言'
  return '其他'
}

function shouldKeepVoice(voice: { voice_id: string, voice_name: string }) {
  const language = extractLanguage(voice.voice_id, voice.voice_name)
  if (language !== '中文' && language !== '粤语') return false

  const text = `${voice.voice_id} ${voice.voice_name}`.toLowerCase()

  const excludedPatterns = [
    'jingpin',
    '-beta',
    'cartoon_pig',
    'cute_boy',
    'lovely_girl',
    'clever_boy',
    'robot_armor',
    'news_anchor',
    'male_announcer',
    'radio_host',
    'hk_flight_attendant',
  ]

  return !excludedPatterns.some(pattern => text.includes(pattern))
}

export default app
