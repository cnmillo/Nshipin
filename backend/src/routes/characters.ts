import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, notFound, now } from '../utils/response.js'
import { generateVoiceSample } from '../services/tts-generation.js'
import { generateImage } from '../services/image-generation.js'
import { applyStyleToImagePrompt, getDramaStyle } from '../services/style-prompts.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

function inferGenderFromVoice(voiceStyle: string): string {
  const text = voiceStyle.toLowerCase()
  if (/female|femme|feminine|女声|xiaoxiao|xuan|xiaoyi|huihui|nv|girl|woman|sakura|meihua|luna|nova|shimmer|晓|小|妹/i.test(text)) return '女声'
  if (/male|masculine|男声|yunxi|yunjian|yunyang|yunxia|echo|onyx|fable|shimmer|云|哥|弟|爷|boy|man|dude|guy/i.test(text)) return '男声'
  return ''
}

function buildCharImagePrompt(char: any, style?: string | null): { prompt: string; gender: string } {
  const genderHint = char.gender || inferGenderFromVoice(char.voiceStyle || '')
  const genderText = genderHint === '女声' ? 'female character, young woman' : genderHint === '男声' ? 'male character, young man' : 'character'
  let prompt = `${char.name} is a ${genderText}. ${char.appearance || char.description || 'portrait'}, character design sheet, three views, front view, side view, back view, white background, full body, consistent proportions, turnaround sheet, high quality, consistent art style, no text, no watermark`
  prompt = applyStyleToImagePrompt(prompt, style)
  return { prompt, gender: genderHint }
}

const app = new Hono()

// PUT /characters/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [existing] = db.select().from(schema.characters).where(eq(schema.characters.id, id)).all()
  if (!existing) return notFound(c, 'Character not found')
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  for (const key of ['name', 'gender', 'role', 'description', 'appearance', 'personality', 'voiceStyle', 'voiceProvider', 'imageUrl', 'localPath']) {
    const snakeKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
    if (snakeKey in body) updates[key] = body[snakeKey]
    else if (key in body) updates[key] = body[key]
  }
  if ('voice_style' in body || 'voiceStyle' in body) {
    updates.voiceSampleUrl = null
  }
  db.update(schema.characters).set(updates).where(eq(schema.characters.id, id)).run()
  return success(c)
})

// DELETE /characters/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.update(schema.characters).set({ deletedAt: now() }).where(eq(schema.characters.id, id)).run()
  return success(c)
})

// POST /characters/:id/generate-voice-sample — 生成角色音色试听
app.post('/:id/generate-voice-sample', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json().catch(() => ({}))
  const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, id)).all()
  if (!char) return badRequest(c, 'Character not found')
  if (!char.voiceStyle) return badRequest(c, '请先分配音色')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')

  try {
    logTaskStart('VoiceSample', 'generate', { characterId: id, characterName: char.name, episodeId: ep.id, voice: char.voiceStyle, voiceProvider: char.voiceProvider })
    const audioPath = await generateVoiceSample(char.name, char.voiceStyle, ep.audioConfigId ?? undefined, char.voiceProvider ?? undefined)
    db.update(schema.characters)
      .set({ voiceSampleUrl: audioPath, updatedAt: now() })
      .where(eq(schema.characters.id, id)).run()
    logTaskSuccess('VoiceSample', 'generate', { characterId: id, path: audioPath })
    return success(c, { voice_sample_url: audioPath })
  } catch (err: any) {
    const msg = err?.message || String(err)
    logTaskError('VoiceSample', 'generate', { characterId: id, error: msg })
    return badRequest(c, `TTS 生成失败: ${msg}`)
  }
})

// POST /characters/:id/generate-image
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, id)).all()
  if (!char) return badRequest(c, 'Character not found')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')

  const dramaStyle = getDramaStyle(char.dramaId)
  const { prompt, gender: genderHint } = buildCharImagePrompt(char, dramaStyle)
  try {
    logTaskStart('CharacterImage', 'generate', { characterId: id, episodeId: ep.id, dramaId: char.dramaId, gender: genderHint, style: dramaStyle })
    const genId = await generateImage({ characterId: id, dramaId: char.dramaId, prompt, configId: ep.imageConfigId ?? undefined })
    logTaskSuccess('CharacterImage', 'generate', { characterId: id, generationId: genId })
    return success(c, { image_generation_id: genId })
  } catch (err: any) {
    logTaskError('CharacterImage', 'generate', { characterId: id, error: err.message })
    return badRequest(c, err.message)
  }
})

// POST /characters/batch-generate-images
app.post('/batch-generate-images', async (c) => {
  const body = await c.req.json()
  const ids: number[] = body.character_ids || []
  if (!body.episode_id) return badRequest(c, 'episode_id is required')
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')
  const results: number[] = []
  for (const cid of ids) {
    const [char] = db.select().from(schema.characters).where(eq(schema.characters.id, cid)).all()
    if (!char) continue
    const dramaStyle = getDramaStyle(char.dramaId)
    const { prompt } = buildCharImagePrompt(char, dramaStyle)
    try {
      const genId = await generateImage({ characterId: cid, dramaId: char.dramaId, prompt, configId: ep.imageConfigId ?? undefined })
      results.push(genId)
    } catch {}
  }
  logTaskSuccess('CharacterImage', 'batch-generate', { episodeId: ep.id, requested: ids.length, started: results.length })
  return success(c, { count: results.length, ids: results })
})

export default app
