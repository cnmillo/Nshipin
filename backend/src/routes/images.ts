import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, now, badRequest } from '../utils/response.js'
import { generateImage } from '../services/image-generation.js'
import { getStyleKeywords } from '../utils/transform.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

// POST /images — Generate image
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.prompt) return badRequest(c, 'prompt is required')

  try {
    let configId: number | undefined = body.config_id
    let dramaStyle = 'realistic'
    let characterAppearanceHint = ''
    if (body.storyboard_id) {
      const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, Number(body.storyboard_id))).all()
      if (sb) {
        const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
        if (ep?.imageConfigId != null) configId = ep.imageConfigId
        if (ep?.dramaId) {
          const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).all()
          dramaStyle = drama?.style || 'realistic'
        }
        const charIds = db.select().from(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, sb.id)).all()
          .map(r => r.characterId)
        if (charIds.length) {
          const charRows = db.select().from(schema.characters).all()
            .filter(c => charIds.includes(c.id))
          const descs = charRows.map(c => {
            const parts = [c.name]
            if (c.gender) parts.push(c.gender)
            if (c.appearance) parts.push(c.appearance)
            return parts.join('，')
          }).filter(d => d.length > 1)
          if (descs.length) characterAppearanceHint = `；角色外貌：${descs.join('；')}`
        }
      }
    } else if (body.drama_id) {
      const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, Number(body.drama_id))).all()
      dramaStyle = drama?.style || 'realistic'
    }

    // 注入视觉风格关键词
    const frameType = body.frame_type || 'scene'
    const styleType = frameType === 'character' ? 'character' : 'scene'
    const styleKeywords = getStyleKeywords(dramaStyle, styleType)
    const hasRefImage = frameType === 'last_frame' && Array.isArray(body.reference_images) && body.reference_images.length > 0
    const consistencyHint = hasRefImage ? '. CRITICAL: strictly preserve identical character appearance (face, hairstyle, body type), identical clothing (style, color, pattern), identical environment (furniture, props, lighting, background) as the reference image. Only pose and expression may differ' : ''
    const needCharHint = characterAppearanceHint && !body.prompt?.includes('Character appearance')
    const basePrompt = body.prompt ? `${body.prompt}${needCharHint ? characterAppearanceHint : ''}` : (characterAppearanceHint ? characterAppearanceHint.slice(1) : '')
    const prompt = basePrompt ? `${basePrompt}, ${styleKeywords}${consistencyHint}` : `${styleKeywords}${consistencyHint}`

    logTaskStart('ImageAPI', 'generate', {
      storyboardId: body.storyboard_id,
      sceneId: body.scene_id,
      characterId: body.character_id,
      dramaId: body.drama_id,
      frameType: body.frame_type,
    })
    logTaskPayload('ImageAPI', 'request body', body)
    const id = await generateImage({
      storyboardId: body.storyboard_id,
      dramaId: body.drama_id,
      sceneId: body.scene_id,
      characterId: body.character_id,
      prompt,
      model: body.model,
      size: body.size,
      referenceImages: body.reference_images,
      frameType: body.frame_type,
      configId,
    })

    const [record] = db.select().from(schema.imageGenerations)
      .where(eq(schema.imageGenerations.id, id)).all()
    logTaskSuccess('ImageAPI', 'generate', { generationId: id, provider: record?.provider })
    return created(c, record)
  } catch (err: any) {
    logTaskError('ImageAPI', 'generate', { error: err.message })
    return badRequest(c, err.message)
  }
})

// GET /images/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, id)).all()
  return success(c, row || null)
})

// GET /images — List by storyboard_id or drama_id
app.get('/', async (c) => {
  const storyboardId = c.req.query('storyboard_id')
  const dramaId = c.req.query('drama_id')

  if (!storyboardId && !dramaId) {
    return badRequest(c, 'storyboard_id or drama_id is required')
  }

  const conditions = []
  if (storyboardId) conditions.push(eq(schema.imageGenerations.storyboardId, Number(storyboardId)))
  if (dramaId) conditions.push(eq(schema.imageGenerations.dramaId, Number(dramaId)))

  const rows = db.select().from(schema.imageGenerations).where(and(...conditions)).all()

  return success(c, rows)
})

// DELETE /images/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.delete(schema.imageGenerations).where(eq(schema.imageGenerations.id, id)).run()
  return success(c)
})

export default app
