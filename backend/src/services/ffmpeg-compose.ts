/**
 * FFmpeg 单镜头合成 — 视频 + TTS音频 + 烧录字幕
 */
import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import { v4 as uuid } from 'uuid'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'
import { findFfmpeg } from '../utils/ffmpeg-path.js'
import { generateTTS } from './tts-generation.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')
const DATA_ROOT = path.resolve(__dirname, '../../../data')

const FFMPEG_PATH = findFfmpeg()
ffmpeg.setFfmpegPath(FFMPEG_PATH)
let subtitleFilterSupport: boolean | null = null
const IGNORE_TTS_SPEAKERS = /^(环境音|环境声|音效|效果音|sfx|sound ?effect|bgm|背景音|背景音乐|ambient)$/i
const IGNORE_TTS_TEXT = /^(无|无对白|无台词|无旁白|无需配音|无需对白|none|null|n\/a|na|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音|背景音乐|bgm|sfx|ambient)$/i

function fmtSrtTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.round((sec % 1) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

function supportsSubtitleFilter(): boolean {
  if (subtitleFilterSupport != null) return subtitleFilterSupport
  try {
    const output = execFileSync(FFMPEG_PATH, ['-hide_banner', '-filters'], { encoding: 'utf8' })
    subtitleFilterSupport = /\bsubtitles\b/.test(output)
  } catch {
    subtitleFilterSupport = false
  }
  return subtitleFilterSupport
}

function parseDialogueForTTS(dialogue?: string | null) {
  const raw = dialogue?.trim() || ''
  if (!raw) return { speaker: '', pureText: '', ignorable: true }
  // 尝试按 "角色名：台词" 模式拆分多角色对白
  const pattern = /([^：:]+?)[：:]\s*([^：:]*?)(?=\s+[^：:]+?[：:]|$)/g
  const segments: { speaker: string; text: string }[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    const speaker = match[1].replace(/[（(].+?[)）]/g, '').trim()
    const text = match[2].replace(/[（(].+?[)）]/g, '').trim()
    if (speaker && text) segments.push({ speaker, text })
  }
  if (segments.length === 0) {
    const pureText = raw.replace(/[（(].+?[)）]/g, '').trim()
    if (!pureText || IGNORE_TTS_TEXT.test(pureText)) return { speaker: '', pureText: '', ignorable: true }
    return { speaker: '', pureText, ignorable: false }
  }
  // 多角色时，pureText 为全部台词拼接（用于字幕），speaker 为第一个说话人（用于回退音色查找）
  const firstSpeaker = segments[0].speaker
  if (IGNORE_TTS_SPEAKERS.test(firstSpeaker)) {
    const nonIgnored = segments.find(s => !IGNORE_TTS_SPEAKERS.test(s.speaker))
    if (!nonIgnored) return { speaker: '', pureText: '', ignorable: true }
  }
  const pureText = segments.map(s => s.text).join(' ')
  const ignorable = !pureText || IGNORE_TTS_TEXT.test(pureText)
  return { speaker: firstSpeaker, pureText, ignorable }
}

/**
 * 合成单个镜头：视频 + TTS对白音频 + 烧录字幕
 */
export async function composeStoryboard(storyboardId: number): Promise<string> {
  const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
  if (!sb) throw new Error(`Storyboard ${storyboardId} not found`)
  if (!sb.videoUrl) throw new Error(`Storyboard ${storyboardId} has no video`)
  db.update(schema.storyboards)
    .set({ status: 'compose_processing', composedVideoUrl: null, updatedAt: now() })
    .where(eq(schema.storyboards.id, storyboardId))
    .run()

  logTaskStart('ComposeTask', 'storyboard-compose', {
    storyboardId,
    storyboardNumber: sb.storyboardNumber,
    episodeId: sb.episodeId,
  })

  const videoPath = toAbsPath(sb.videoUrl)
  let audioPath: string | null = null
  let subtitlePath: string | null = null
  const parsedDialogue = parseDialogueForTTS(sb.dialogue)

  // 1. 生成 TTS 音频（如果有对白）
  try {
    if (!parsedDialogue.ignorable) {
      if (sb.ttsAudioUrl) {
        const existingAudioPath = toAbsPath(sb.ttsAudioUrl)
        if (fs.existsSync(existingAudioPath)) {
          audioPath = existingAudioPath
        }
      }

      if (!audioPath) {
        let voiceId = 'alloy'
        let voiceProvider: string | null = null
        const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, sb.episodeId)).all()
        if (parsedDialogue.speaker) {
          const charName = parsedDialogue.speaker
          if (ep) {
            const chars = db.select().from(schema.characters)
              .where(eq(schema.characters.dramaId, ep.dramaId)).all()
            const found = chars.find(c => c.name === charName)
            if (found?.voiceStyle) voiceId = found.voiceStyle
            if (found?.voiceProvider) voiceProvider = found.voiceProvider
          }
        }

        // 自动处理 Edge TTS 音色的默认值
        if (voiceProvider === 'edge-tts' && voiceId === 'alloy') {
          voiceId = 'zh-CN-XiaoxiaoNeural'
        } else if (ep?.audioConfigId) {
          const [cfg] = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, ep.audioConfigId)).all()
          if (cfg?.provider === 'edge-tts' && voiceId === 'alloy') {
            voiceId = 'zh-CN-XiaoxiaoNeural'
          }
        }

        const pureDialogue = parsedDialogue.pureText
        if (pureDialogue) {
          logTaskProgress('ComposeTask', 'generate-inline-tts', { storyboardId, voiceId, voiceProvider, textPreview: pureDialogue.slice(0, 40) })
          const ttsPath = await generateTTS({ text: pureDialogue, voice: voiceId, configId: ep?.audioConfigId ?? undefined, voiceProvider })
          audioPath = toAbsPath(ttsPath)
          db.update(schema.storyboards).set({ ttsAudioUrl: ttsPath, updatedAt: now() })
            .where(eq(schema.storyboards.id, storyboardId)).run()
        }
      }
    }

    // 2. 生成字幕文件（SRT）
    if (!parsedDialogue.ignorable) {
      const srtDir = path.join(STORAGE_ROOT, 'subtitles')
      fs.mkdirSync(srtDir, { recursive: true })
      const srtFilename = `${uuid()}.srt`
      subtitlePath = path.join(srtDir, srtFilename)

      let actualDuration = sb.duration || 10
      try {
        const probeData = await new Promise<number>((resolve) => {
          ffmpeg.ffprobe(videoPath, (err, meta) => {
            if (err || !meta.format?.duration) resolve(actualDuration)
            else resolve(Math.round(meta.format.duration * 10) / 10)
          })
        })
        actualDuration = probeData
      } catch {}

      const pureText = parsedDialogue.pureText
      const CHARS_PER_SEGMENT = 12
      const segments: string[] = []
      for (let i = 0; i < pureText.length; i += CHARS_PER_SEGMENT) {
        segments.push(pureText.slice(i, i + CHARS_PER_SEGMENT))
      }

      const totalSec = Math.max(actualDuration, 1)
      const segDuration = totalSec / segments.length
      const srtLines: string[] = []
      for (let i = 0; i < segments.length; i++) {
        const startSec = i * segDuration
        const endSec = Math.min((i + 1) * segDuration, totalSec)
        srtLines.push(`${i + 1}`)
        srtLines.push(`${fmtSrtTime(startSec)} --> ${fmtSrtTime(endSec)}`)
        srtLines.push(segments[i])
        srtLines.push('')
      }
      fs.writeFileSync(subtitlePath, srtLines.join('\n'), 'utf-8')

      const srtRelative = `static/subtitles/${srtFilename}`
      db.update(schema.storyboards).set({ subtitleUrl: srtRelative, updatedAt: now() })
        .where(eq(schema.storyboards.id, storyboardId)).run()
    }

    // 3. FFmpeg 合成
    const outputDir = path.join(STORAGE_ROOT, 'composed')
    fs.mkdirSync(outputDir, { recursive: true })
    const outputFilename = `${uuid()}.mp4`
    const outputPath = path.join(outputDir, outputFilename)

    await new Promise<void>((resolve, reject) => {
      let cmd = ffmpeg(videoPath)

      if (audioPath) {
        cmd = cmd.input(audioPath)
      } else {
        cmd = cmd.input('anullsrc=channel_layout=stereo:sample_rate=48000')
        cmd = cmd.inputOptions(['-f', 'lavfi'])
      }

      const filters: string[] = []

      if (subtitlePath && supportsSubtitleFilter()) {
        const escapedPath = subtitlePath
          .replace(/\\/g, '/')
          .replace(/:/g, '\\:')
          .replace(/'/g, "\\'")
        const forceStyle = 'FontSize=16\\,PrimaryColour=&HFFFFFF&\\,OutlineColour=&H000000&\\,Outline=2\\,MarginV=45\\,MarginL=20\\,MarginR=20\\,WrapStyle=0'
        filters.push(`subtitles=filename='${escapedPath}':force_style='${forceStyle}'`)
      } else if (subtitlePath) {
        logTaskProgress('ComposeTask', 'subtitle-filter-unavailable', {
          storyboardId,
          subtitlePath,
        })
      }

      if (filters.length > 0) {
        cmd = cmd.videoFilter(filters)
      }

      const outputOptions = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest']

      cmd.outputOptions(outputOptions)
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    })

    const composedRelative = `static/composed/${outputFilename}`
    db.update(schema.storyboards).set({ composedVideoUrl: composedRelative, status: 'compose_completed', updatedAt: now() })
      .where(eq(schema.storyboards.id, storyboardId)).run()

    logTaskSuccess('ComposeTask', 'storyboard-compose', {
      storyboardId,
      storyboardNumber: sb.storyboardNumber,
      output: composedRelative,
    })
    return composedRelative
  } catch (err) {
    db.update(schema.storyboards)
      .set({ status: 'compose_failed', composedVideoUrl: null, updatedAt: now() })
      .where(eq(schema.storyboards.id, storyboardId))
      .run()
    throw err
  }
}
