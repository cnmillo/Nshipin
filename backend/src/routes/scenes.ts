import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, badRequest, notFound, now } from '../utils/response.js'
import { generateImage } from '../services/image-generation.js'
import { applyStyleToImagePrompt, getDramaStyle } from '../services/style-prompts.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

// POST /scenes
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()
  const res = db.insert(schema.scenes).values({
    dramaId: body.drama_id,
    episodeId: body.episode_id,
    location: body.location,
    time: body.time || '',
    prompt: body.prompt || body.location,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const [result] = db.select().from(schema.scenes)
    .where(eq(schema.scenes.id, Number(res.lastInsertRowid))).all()
  return created(c, result)
})

// PUT /scenes/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [existing] = db.select().from(schema.scenes).where(eq(schema.scenes.id, id)).all()
  if (!existing) return notFound(c, 'Scene not found')
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.location !== undefined) updates.location = body.location
  if (body.time !== undefined) updates.time = body.time
  if (body.prompt !== undefined) updates.prompt = body.prompt
  if (body.imageUrl !== undefined) updates.imageUrl = body.imageUrl
  if (body.image_url !== undefined) updates.imageUrl = body.image_url
  db.update(schema.scenes).set(updates).where(eq(schema.scenes.id, id)).run()
  return success(c)
})

// POST /scenes/:id/generate-image
app.post('/:id/generate-image', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [scene] = db.select().from(schema.scenes).where(eq(schema.scenes.id, id)).all()
  if (!scene) return badRequest(c, 'Scene not found')
  if (!body.episode_id) return badRequest(c, 'episode_id is required')
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, Number(body.episode_id))).all()
  if (!ep) return badRequest(c, 'Episode not found')

  const sbs = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.sceneId, id)).all()
  const sbIds = sbs.map(s => s.id)

  let charContext = ''
  if (sbIds.length) {
    const sbChars = db.select().from(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, sbIds[0]))
      .all()
    const charIds = sbChars.map(sc => sc.characterId)
    if (charIds.length) {
      const chars = db.select().from(schema.characters)
        .where(eq(schema.characters.id, charIds[0])).all()
      if (chars.length) {
        const ch = chars[0]
        const genderHint = ch.gender || ''
        const genderRef = genderHint === '女' || genderHint === '女声' ? 'female character' : genderHint === '男' || genderHint === '男声' ? 'male character' : 'character'
        charContext = `This scene features character "${ch.name}" (${genderRef}${ch.appearance ? ', ' + ch.appearance : ''}). Character appearance must be consistent with their portrait image.`
      }
    }
  }

  const location = scene.location || ''
  const time = scene.time || ''
  const userPrompt = scene.prompt || ''
  const basePrompt = `${location}${time ? ' at ' + time : ''}. A cinematic scene.`
  const characterRef = charContext
    ? `${charContext}. Pure background scene, no characters or people in frame — characters described above should NOT appear in this image.`
    : `Pure background scene. No characters, no people, no figures.`
  const prompt = userPrompt || `${basePrompt} ${characterRef} High quality, atmospheric lighting, consistent art style, no text, no watermark`

  const dramaStyle = getDramaStyle(scene.dramaId)
  const styledPrompt = applyStyleToImagePrompt(prompt, dramaStyle)

  try {
    logTaskStart('SceneImage', 'generate', { sceneId: id, episodeId: ep.id, dramaId: scene.dramaId, location: scene.location, hasCharContext: !!charContext, style: dramaStyle })
    db.update(schema.scenes).set({ status: 'processing', updatedAt: now() }).where(eq(schema.scenes.id, id)).run()
    const genId = await generateImage({ sceneId: id, dramaId: scene.dramaId, prompt: styledPrompt, configId: ep.imageConfigId ?? undefined })
    logTaskSuccess('SceneImage', 'generate', { sceneId: id, generationId: genId })
    return success(c, { image_generation_id: genId })
  } catch (err: any) {
    logTaskError('SceneImage', 'generate', { sceneId: id, error: err.message })
    db.update(schema.scenes).set({ status: 'failed', updatedAt: now() }).where(eq(schema.scenes.id, id)).run()
    return badRequest(c, err.message)
  }
})

// DELETE /scenes/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.update(schema.scenes).set({ deletedAt: now() }).where(eq(schema.scenes.id, id)).run()
  return success(c)
})

export default app
