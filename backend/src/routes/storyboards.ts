import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, now, badRequest } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { findFfmpeg } from '../utils/ffmpeg-path.js'
import { generateTTS } from '../services/tts-generation.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { v4 as uuid } from 'uuid'
import { execFileSync } from 'child_process'

const app = new Hono()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')

const IGNORE_TTS_SPEAKERS = /^(环境音|环境声|音效|效果音|sfx|sound ?effect|bgm|背景音|背景音乐|ambient)$/i
const IGNORE_TTS_TEXT = /^(无|无对白|无台词|无旁白|无需配音|无需对白|none|null|n\/a|na|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音|背景音乐|bgm|sfx|ambient)$/i

interface DialogueSegment {
  speaker: string
  text: string
}

interface CharInfo {
  name: string
  gender?: string | null
}

/**
 * 解析对白，支持多角色拆分
 * 格式1：角色1：台词1\n角色2：台词2（分行，推荐格式）
 * 格式2：角色1：台词1 角色2：台词2（同行，兼容格式）
 * 格式3：纯文本无角色前缀（回退：按句子拆分分配给关联角色）
 */
function parseDialogueForTTS(dialogue?: string | null, charInfos: CharInfo[] = []): { segments: DialogueSegment[], ignorable: boolean } {
  const raw = dialogue?.trim() || ''
  if (!raw) return { segments: [], ignorable: true }

  const characterNames = charInfos.map(c => c.name)

  const lines = raw.split(/\n/).map(l => l.trim()).filter(Boolean)
  const segments: DialogueSegment[] = []

  for (const line of lines) {
    const lineMatch = line.match(/^(.+?)[:：]\s*(.+)$/)
    if (lineMatch) {
      const speaker = lineMatch[1].replace(/[（(].+?[)）]/g, '').trim()
      const text = lineMatch[2].replace(/[（(].+?[)）]/g, '').trim()
      if (speaker && text && !IGNORE_TTS_SPEAKERS.test(speaker)) {
        segments.push({ speaker, text })
      }
    } else {
      const pattern = /([^：:\n]+?)[：:]\s*([^：:\n]*?)(?=\s+[^：:\n]+?[：:]|$)/g
      let m: RegExpExecArray | null
      let foundAny = false
      while ((m = pattern.exec(line)) !== null) {
        const speaker = m[1].replace(/[（(].+?[)）]/g, '').trim()
        const text = m[2].replace(/[（(].+?[)）]/g, '').trim()
        if (speaker && text && !IGNORE_TTS_SPEAKERS.test(speaker)) {
          segments.push({ speaker, text })
          foundAny = true
        }
      }
      if (!foundAny) {
        const pureText = line.replace(/[（(].+?[)）]/g, '').trim()
        if (pureText && !IGNORE_TTS_TEXT.test(pureText)) {
          segments.push({ speaker: '', text: pureText })
        }
      }
    }
  }

  const HONORIFIC_GENDER: Record<string, '女' | '男'> = {
    '妈妈': '女', '奶奶': '女', '阿姨': '女', '姑姑': '女', '姐姐': '女',
    '爸爸': '男', '爷爷': '男', '叔叔': '男', '舅舅': '男', '哥哥': '男',
  }
  const HONORIFIC_ROLE: Record<string, string> = {
    '医生': '医', '老师': '师', '护士': '护',
  }

  function findAddressee(sentence: string): string {
    for (const name of characterNames) {
      for (let len = name.length; len >= 2; len--) {
        for (let start = 0; start <= name.length - len; start++) {
          const sub = name.substring(start, start + len)
          if (sub.length >= 2 && sentence.includes(sub)) return name
        }
      }
    }
    for (const [honorific, gender] of Object.entries(HONORIFIC_GENDER)) {
      if (sentence.includes(honorific)) {
        const found = charInfos.find(c => c.gender === gender)
        if (found) return found.name
      }
    }
    for (const [honorific, key] of Object.entries(HONORIFIC_ROLE)) {
      if (sentence.includes(honorific)) {
        const found = characterNames.find(n => n.includes(key))
        if (found) return found
      }
    }
    return ''
  }

  function inferSpeaker(sentence: string): string | null {
    const addressee = findAddressee(sentence)
    if (addressee) return characterNames.find(n => n !== addressee) || null
    return null
  }

  function pickDefaultSpeaker(): string {
    const honorificRoleChar = characterNames.find(n => Object.values(HONORIFIC_ROLE).some(k => n.includes(k)))
    if (honorificRoleChar) return honorificRoleChar
    const femaleChar = charInfos.find(c => c.gender === '女')
    if (femaleChar) return femaleChar.name
    return characterNames[0]
  }

  // 回退：单段对白但关联了多个角色，按句子拆分分配
  if (segments.length === 1 && characterNames.length >= 2) {
    const sentences = segments[0].text.split(/(?<=[。！？!?])\s*/).filter(Boolean)
    if (sentences.length >= 2) {
      const distributed: DialogueSegment[] = []
      const firstHint = inferSpeaker(sentences[0])
      let currentSpeaker: string

      if (firstHint) {
        currentSpeaker = firstHint
      } else {
        const firstIsQuestion = /[？?]$/.test(sentences[0].trim())
        const secondHint = inferSpeaker(sentences[1])
        if (firstIsQuestion && secondHint && characterNames.length === 2) {
          currentSpeaker = characterNames.find(n => n !== secondHint) || characterNames[0]
        } else {
          currentSpeaker = pickDefaultSpeaker()
        }
      }

      for (let i = 0; i < sentences.length; i++) {
        const hint = inferSpeaker(sentences[i])
        if (hint) {
          currentSpeaker = hint
        } else if (i > 0 && characterNames.length === 2) {
          const prev = distributed[i - 1]
          const prevIsQuestion = /[？?]$/.test(prev.text.trim())
          const currStartsWithSelf = /^(我|我觉得|我认为|我想|我不知道|我可能|我应该)/.test(sentences[i].trim()) && !sentences[i].trim().startsWith('我们')
          if (prevIsQuestion && currStartsWithSelf) {
            currentSpeaker = characterNames.find(n => n !== prev.speaker) || currentSpeaker
          }
        }
        distributed.push({ speaker: currentSpeaker, text: sentences[i] })
      }

      return { segments: distributed, ignorable: false }
    }

    // 单句对白但有多个关联角色：用被称呼者推断，否则用默认说话人
    const hint = inferSpeaker(segments[0].text)
    return { segments: [{ speaker: hint || pickDefaultSpeaker(), text: segments[0].text }], ignorable: false }
  }

  // 回退2：无角色前缀且关联了角色，按句子拆分分配
  if (segments.length === 1 && !segments[0].speaker && characterNames.length >= 1) {
    const sentences = segments[0].text.split(/(?<=[。！？!?])\s*/).filter(Boolean)
    if (sentences.length >= 2) {
      const defaultSpeaker = pickDefaultSpeaker()
      const distributed: DialogueSegment[] = []
      for (const sentence of sentences) {
        const hint = inferSpeaker(sentence)
        distributed.push({ speaker: hint || defaultSpeaker, text: sentence })
      }
      return { segments: distributed, ignorable: false }
    }
    // 单句
    const hint = inferSpeaker(segments[0].text)
    return { segments: [{ speaker: hint || pickDefaultSpeaker(), text: segments[0].text }], ignorable: false }
  }

  if (segments.length === 0) {
    const pureText = raw.replace(/[（(].+?[)）]/g, '').trim()
    if (!pureText || IGNORE_TTS_TEXT.test(pureText)) {
      return { segments: [], ignorable: true }
    }
    return { segments: [{ speaker: '', text: pureText }], ignorable: false }
  }

  return { segments, ignorable: false }
}

/**
 * 拼接多个音频文件
 * 优先使用 ffmpeg concat，不可用时回退到 MP3 二进制拼接
 */
function concatAudioFiles(audioPaths: string[], outputPath: string): void {
  // 尝试 ffmpeg concat
  try {
    const listContent = audioPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')
    const listFile = path.join(path.dirname(outputPath), `concat_${uuid()}.txt`)
    fs.writeFileSync(listFile, listContent, 'utf8')
    try {
      execFileSync(findFfmpeg(), ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outputPath], {
        timeout: 30000,
        stdio: 'pipe',
      })
      return
    } finally {
      fs.unlinkSync(listFile)
    }
  } catch {}

  // 回退：MP3 二进制拼接（MP3 帧独立，可直接拼接）
  const buffers = audioPaths.map(p => fs.readFileSync(p))
  fs.writeFileSync(outputPath, Buffer.concat(buffers))
}

function syncStoryboardCharacters(storyboardId: number, characterIds: number[]) {
  db.delete(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
    .run()

  const uniqueIds = [...new Set((characterIds || []).filter(Boolean))]
  if (!uniqueIds.length) return

  for (const characterId of uniqueIds) {
    db.insert(schema.storyboardCharacters).values({
      storyboardId,
      characterId,
    }).run()
  }
}

function getStoryboardCharacterIds(storyboardId: number) {
  return db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).all()
    .map(link => link.characterId)
}

function validateStoryboardBindings(episodeId: number, sceneId: number | null | undefined, characterIds: number[] | undefined) {
  const episodeSceneIds = new Set(
    db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId)).all()
      .map(link => link.sceneId),
  )
  const episodeCharacterIds = new Set(
    db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
      .map(link => link.characterId),
  )

  if (sceneId != null && !episodeSceneIds.has(sceneId)) {
    throw new Error('scene_id 必须来自当前集已关联场景')
  }

  const invalidCharacterIds = (characterIds || []).filter(id => !episodeCharacterIds.has(id))
  if (invalidCharacterIds.length) {
    throw new Error('character_ids 必须来自当前集已关联角色')
  }
}

// POST /storyboards
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()
  logTaskStart('StoryboardAPI', 'create', {
    episodeId: body.episode_id,
    shotNumber: body.storyboard_number || 1,
    sceneId: body.scene_id,
    characterIds: body.character_ids,
  })
  logTaskPayload('StoryboardAPI', 'create body', body)
  validateStoryboardBindings(body.episode_id, body.scene_id, body.character_ids)
  const res = db.insert(schema.storyboards).values({
    episodeId: body.episode_id,
    storyboardNumber: body.storyboard_number || 1,
    title: body.title,
    description: body.description,
    action: body.action,
    dialogue: body.dialogue,
    sceneId: body.scene_id,
    duration: body.duration || 10,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  syncStoryboardCharacters(Number(res.lastInsertRowid), body.character_ids || [])
  const [result] = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.id, Number(res.lastInsertRowid))).all()
  logTaskSuccess('StoryboardAPI', 'create', {
    storyboardId: result.id,
    episodeId: result.episodeId,
    shotNumber: result.storyboardNumber,
  })
  return created(c, {
    ...toSnakeCase(result),
    character_ids: getStoryboardCharacterIds(result.id),
  })
})

// PUT /storyboards/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [storyboard] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
  if (!storyboard) return badRequest(c, '镜头不存在')
  logTaskStart('StoryboardAPI', 'update', {
    storyboardId: id,
    episodeId: storyboard.episodeId,
    fields: Object.keys(body),
  })
  logTaskPayload('StoryboardAPI', 'update body', body)

  const fieldMap: Record<string, string> = {
    title: 'title', description: 'description', shot_type: 'shotType',
    angle: 'angle', movement: 'movement', action: 'action',
    dialogue: 'dialogue', duration: 'duration', video_prompt: 'videoPrompt',
    image_prompt: 'imagePrompt', scene_id: 'sceneId', location: 'location',
    time: 'time', atmosphere: 'atmosphere', result: 'result',
    bgm_prompt: 'bgmPrompt', sound_effect: 'soundEffect',
    firstFrameImage: 'firstFrameImage', lastFrameImage: 'lastFrameImage',
    first_frame_image: 'firstFrameImage', last_frame_image: 'lastFrameImage',
    composedImage: 'composedImage', composed_image: 'composedImage',
  }

  const updates: Record<string, any> = { updatedAt: now() }
  for (const [snakeKey, camelKey] of Object.entries(fieldMap)) {
    if (snakeKey in body) updates[camelKey] = body[snakeKey]
  }

  if ('dialogue' in body) {
    updates.ttsAudioUrl = null
    updates.subtitleUrl = null
  }

  validateStoryboardBindings(
    storyboard.episodeId,
    'scene_id' in body ? body.scene_id : storyboard.sceneId,
    'character_ids' in body ? body.character_ids : getStoryboardCharacterIds(id),
  )

  db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, id)).run()
  if ('character_ids' in body) syncStoryboardCharacters(id, body.character_ids || [])
  logTaskSuccess('StoryboardAPI', 'update', {
    storyboardId: id,
    updatedFields: Object.keys(updates),
    characterIds: body.character_ids,
  })
  return success(c)
})

// POST /storyboards/:id/generate-tts
app.post('/:id/generate-tts', async (c) => {
  const id = Number(c.req.param('id'))
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
  if (!sb) return badRequest(c, '镜头不存在')

  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
  // 预加载该集所有角色
  const allChars = ep
    ? db.select().from(schema.characters).where(eq(schema.characters.dramaId, ep.dramaId)).all()
    : []

  // 获取关联角色名列表（用于无角色前缀时的回退分配）
  const sbCharIds = db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, id)).all()
    .map(link => link.characterId)
  const sbCharInfos: CharInfo[] = allChars
    .filter(ch => sbCharIds.includes(ch.id))
    .map(ch => ({ name: ch.name, gender: ch.gender }))

  const parsed = parseDialogueForTTS(sb.dialogue, sbCharInfos)
  if (parsed.ignorable || parsed.segments.length === 0) return badRequest(c, '该镜头没有可生成的对白或旁白')

  logTaskStart('StoryboardAPI', 'generate-tts', {
    storyboardId: id,
    episodeId: sb.episodeId,
    dialoguePreview: (sb.dialogue || '').slice(0, 40),
    segmentCount: parsed.segments.length,
  })
  logTaskPayload('StoryboardAPI', 'generate-tts input', {
    storyboardId: id,
    episodeId: sb.episodeId,
    dialogue: sb.dialogue,
    segments: parsed.segments,
  })

  function findCharVoice(speaker: string): { voiceId: string; voiceProvider: string | null } {
    if (!speaker || /^(旁白|画外音|narrator)$/i.test(speaker)) {
      return { voiceId: 'alloy', voiceProvider: null }
    }
    
    // 优先精确匹配
    let found = allChars.find(ch => ch.name === speaker)
    
    // 如果精确匹配失败，尝试模糊匹配（处理名字中可能的空格、标点差异）
    if (!found) {
      const speakerClean = speaker.trim()
      found = allChars.find(ch => 
        ch.name.trim() === speakerClean ||
        ch.name.includes(speakerClean) ||
        speakerClean.includes(ch.name.trim())
      )
    }
    
    // 如果还是没找到，根据性别选择默认音色
    if (!found) {
      const femaleNames = ['妈妈', '阿姨', '姐姐', '奶奶', '外婆', '姑姑', '妹妹']
      const isFemale = femaleNames.some(n => speaker.includes(n))
      return {
        voiceId: isFemale ? 'zh-CN-XiaoxiaoNeural' : 'zh-CN-YunxiNeural',
        voiceProvider: 'edge-tts'
      }
    }
    
    return {
      voiceId: found?.voiceStyle || 'alloy',
      voiceProvider: found?.voiceProvider || null,
    }
  }

  try {
    // 单角色对白：直接生成
    if (parsed.segments.length === 1) {
      const seg = parsed.segments[0]
      const { voiceId, voiceProvider } = findCharVoice(seg.speaker)
      const audioPath = await generateTTS({ text: seg.text, voice: voiceId, configId: ep?.audioConfigId || null, voiceProvider })

      db.update(schema.storyboards)
        .set({ ttsAudioUrl: audioPath, updatedAt: now() })
        .where(eq(schema.storyboards.id, id))
        .run()

      logTaskSuccess('StoryboardAPI', 'generate-tts', { storyboardId: id, voiceId, voiceProvider, path: audioPath, textLength: seg.text.length })
      return success(c, { tts_audio_url: audioPath, voice_id: voiceId, text: seg.text })
    }

    // 多角色对白：按角色分别生成，再拼接
    const audioPaths: string[] = []
    for (const seg of parsed.segments) {
      const { voiceId, voiceProvider } = findCharVoice(seg.speaker)
      logTaskProgress('StoryboardAPI', 'generate-tts-segment', {
        storyboardId: id, speaker: seg.speaker, voiceId, textPreview: seg.text.slice(0, 30),
      })
      const audioPath = await generateTTS({ text: seg.text, voice: voiceId, configId: ep?.audioConfigId || null, voiceProvider })
      audioPaths.push(audioPath)
    }

    // 拼接所有音频片段
    const audioDir = path.join(STORAGE_ROOT, 'audio')
    fs.mkdirSync(audioDir, { recursive: true })
    const mergedFilename = `${uuid()}.mp3`
    const mergedAbsPath = path.join(audioDir, mergedFilename)

    const absAudioPaths = audioPaths.map(p => {
      if (path.isAbsolute(p)) return p
      if (p.startsWith('static/')) return path.join(path.resolve(__dirname, '../../../data'), p)
      return path.join(STORAGE_ROOT, p)
    })

    concatAudioFiles(absAudioPaths, mergedAbsPath)

    // 清理临时音频片段
    for (const p of absAudioPaths) {
      try { fs.unlinkSync(p) } catch {}
    }

    const relativePath = `static/audio/${mergedFilename}`
    db.update(schema.storyboards)
      .set({ ttsAudioUrl: relativePath, updatedAt: now() })
      .where(eq(schema.storyboards.id, id))
      .run()

    logTaskSuccess('StoryboardAPI', 'generate-tts-multi', {
      storyboardId: id, segmentCount: parsed.segments.length, path: relativePath,
    })
    return success(c, { tts_audio_url: relativePath, segments: parsed.segments.length })
  } catch (err: any) {
    const msg = err?.message || String(err)
    logTaskError('StoryboardAPI', 'generate-tts', { storyboardId: id, error: msg })
    return badRequest(c, `TTS 生成失败: ${msg}`)
  }
})

// DELETE /storyboards/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  logTaskStart('StoryboardAPI', 'delete', { storyboardId: id })
  db.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, id)).run()
  db.delete(schema.storyboards).where(eq(schema.storyboards.id, id)).run()
  logTaskSuccess('StoryboardAPI', 'delete', { storyboardId: id })
  return success(c)
})

export default app
