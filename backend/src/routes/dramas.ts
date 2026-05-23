import { Hono } from 'hono'
import { eq, isNull, like, desc, and, inArray, sql } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, notFound, created, now } from '../utils/response.js'
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js'

const app = new Hono()

// GET /dramas - List dramas
app.get('/', async (c) => {
  const page = Number(c.req.query('page') || 1)
  const pageSize = Number(c.req.query('page_size') || 20)
  const status = c.req.query('status')
  const keyword = c.req.query('keyword')

  // Build WHERE conditions in SQL instead of JS filtering
  const conditions = [isNull(schema.dramas.deletedAt)]
  if (status) conditions.push(eq(schema.dramas.status, status))
  if (keyword) conditions.push(like(schema.dramas.title, `%${keyword}%`))

  const where = conditions.length > 1 ? and(...conditions) : conditions[0]

  // Count with SQL
  const [{ count }] = db.select({ count: sql<number>`count(*)` })
    .from(schema.dramas)
    .where(where)
    .all()

  const items = db.select().from(schema.dramas)
    .where(where)
    .orderBy(desc(schema.dramas.updatedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()

  // Batch query related data instead of N+1
  const dramaIds = items.map(d => d.id)
  const allEps = dramaIds.length ? db.select().from(schema.episodes)
    .where(inArray(schema.episodes.dramaId, dramaIds)).all() : []
  const allChars = dramaIds.length ? db.select().from(schema.characters)
    .where(and(inArray(schema.characters.dramaId, dramaIds), isNull(schema.characters.deletedAt))).all() : []
  const allScns = dramaIds.length ? db.select().from(schema.scenes)
    .where(and(inArray(schema.scenes.dramaId, dramaIds), isNull(schema.scenes.deletedAt))).all() : []

  // Group by dramaId in memory
  const epsByDrama = new Map<number, typeof allEps>()
  const charsByDrama = new Map<number, typeof allChars>()
  const scnsByDrama = new Map<number, typeof allScns>()
  for (const ep of allEps) {
    if (!epsByDrama.has(ep.dramaId)) epsByDrama.set(ep.dramaId, [])
    epsByDrama.get(ep.dramaId)!.push(ep)
  }
  for (const ch of allChars) {
    if (!charsByDrama.has(ch.dramaId)) charsByDrama.set(ch.dramaId, [])
    charsByDrama.get(ch.dramaId)!.push(ch)
  }
  for (const sc of allScns) {
    if (!scnsByDrama.has(sc.dramaId)) scnsByDrama.set(sc.dramaId, [])
    scnsByDrama.get(sc.dramaId)!.push(sc)
  }

  const enriched = items.map(drama => ({
    ...toSnakeCase(drama),
    tags: drama.tags ? JSON.parse(drama.tags) : [],
    total_episodes: (epsByDrama.get(drama.id) || []).length,
    episodes: toSnakeCaseArray(epsByDrama.get(drama.id) || []),
    characters: toSnakeCaseArray(charsByDrama.get(drama.id) || []),
    scenes: toSnakeCaseArray(scnsByDrama.get(drama.id) || []),
  }))

  return success(c, {
    items: enriched,
    pagination: { page, page_size: pageSize, total: count, total_pages: Math.ceil(count / pageSize) },
  })
})

// POST /dramas - Create drama
app.post('/', async (c) => {
  const body = await c.req.json()
  if (!body.title?.trim()) return badRequest(c, 'title is required')
  const ts = now()
  const res = db.insert(schema.dramas).values({
    title: body.title,
    description: body.description,
    genre: body.genre,
    style: body.style,
    tags: body.tags ? JSON.stringify(body.tags) : null,
    metadata: body.metadata,
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const [result] = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, Number(res.lastInsertRowid))).all()

  // Create default episodes
  const totalEpisodes = body.total_episodes || 1
  for (let i = 1; i <= totalEpisodes; i++) {
    db.insert(schema.episodes).values({
      dramaId: result.id,
      episodeNumber: i,
      title: `第${i}集`,
      status: 'draft',
      createdAt: ts,
      updatedAt: ts,
    }).run()
  }

  return created(c, toSnakeCase(result))
})


// GET /dramas/stats — must be before /:id
app.get('/stats', async (c) => {
  const [{ total }] = db.select({ total: sql<number>`count(*)` })
    .from(schema.dramas)
    .where(isNull(schema.dramas.deletedAt))
    .all()
  const byStatusRows = db.select({
    status: schema.dramas.status,
    count: sql<number>`count(*)`,
  })
    .from(schema.dramas)
    .where(isNull(schema.dramas.deletedAt))
    .groupBy(schema.dramas.status)
    .all()
  const by_status = byStatusRows.map(r => ({ status: r.status || 'draft', count: r.count }))
  return success(c, { total, by_status })
})

// GET /dramas/:id - Get drama detail
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, id)).all()
  if (!drama) return notFound(c, '剧本不存在')

  const eps = db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, id)).all()
  const chars = db.select().from(schema.characters)
    .where(and(eq(schema.characters.dramaId, id), isNull(schema.characters.deletedAt))).all()
  const scns = db.select().from(schema.scenes)
    .where(and(eq(schema.scenes.dramaId, id), isNull(schema.scenes.deletedAt))).all()
  const prps = db.select().from(schema.props)
    .where(eq(schema.props.dramaId, id)).all()

  return success(c, {
    ...toSnakeCase(drama),
    tags: drama.tags ? JSON.parse(drama.tags) : [],
    episodes: toSnakeCaseArray(eps),
    characters: toSnakeCaseArray(chars),
    scenes: toSnakeCaseArray(scns),
    props: toSnakeCaseArray(prps),
  })
})

// PUT /dramas/:id - Update drama
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [existing] = db.select().from(schema.dramas).where(eq(schema.dramas.id, id)).all()
  if (!existing) return notFound(c, '剧本不存在')
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }
  if (body.title !== undefined) updates.title = body.title
  if (body.description !== undefined) updates.description = body.description
  if (body.genre !== undefined) updates.genre = body.genre
  if (body.style !== undefined) updates.style = body.style
  if (body.status !== undefined) updates.status = body.status
  if (body.tags !== undefined) updates.tags = JSON.stringify(body.tags)
  if (body.metadata !== undefined) updates.metadata = body.metadata
  db.update(schema.dramas).set(updates).where(eq(schema.dramas.id, id)).run()
  return success(c)
})

// DELETE /dramas/:id - Soft delete
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [existing] = db.select().from(schema.dramas).where(eq(schema.dramas.id, id)).all()
  if (!existing) return notFound(c, '剧本不存在')
  db.update(schema.dramas).set({ deletedAt: now() }).where(eq(schema.dramas.id, id)).run()
  return success(c)
})

// PUT /dramas/:id/characters - Save characters
app.put('/:id/characters', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const body = await c.req.json()
  const chars = body.characters || []
  const ts = now()

  for (const char of chars) {
    if (char.id) {
      db.update(schema.characters).set({ ...char, updatedAt: ts }).where(eq(schema.characters.id, char.id)).run()
    } else {
      db.insert(schema.characters).values({ ...char, dramaId, createdAt: ts, updatedAt: ts }).run()
    }
  }
  return success(c)
})

// PUT /dramas/:id/episodes - Save episodes
app.put('/:id/episodes', async (c) => {
  const dramaId = Number(c.req.param('id'))
  const body = await c.req.json()
  const episodes = body.episodes || []
  const ts = now()

  for (const ep of episodes) {
    if (ep.id) {
      db.update(schema.episodes).set({ ...ep, updatedAt: ts }).where(eq(schema.episodes.id, ep.id)).run()
    } else {
      db.insert(schema.episodes).values({
        ...ep,
        dramaId,
        episodeNumber: ep.episode_number || ep.episodeNumber || 1,
        title: ep.title || '未命名',
        createdAt: ts,
        updatedAt: ts,
      }).run()
    }
  }
  return success(c)
})

export default app
