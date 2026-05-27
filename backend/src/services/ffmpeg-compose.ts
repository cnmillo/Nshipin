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
import { generateTTSWithMetadata } from './tts-generation.js'
import type { WordBoundary } from './adapters/edge-tts.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = process.env.STORAGE_PATH || path.resolve(__dirname, '../../../data/static')
const DATA_ROOT = path.resolve(__dirname, '../../../data')

const FFMPEG_PATH = findFfmpeg()
ffmpeg.setFfmpegPath(FFMPEG_PATH)
let subtitleFilterSupport: boolean | null = null
const IGNORE_TTS_SPEAKERS = /^(环境音|环境声|音效|效果音|sfx|sound ?effect|bgm|背景音|背景音乐|ambient)$/i
const IGNORE_TTS_TEXT = /^(无|无对白|无台词|无旁白|无需配音|无需对白|none|null|n\/a|na|环境音|环境声|音效|效果音|纯音效|纯环境音|只有环境音|仅环境音|背景音|背景音乐|bgm|sfx|ambient)$/i

const SPEED_ADJUST_THRESHOLD = 0.3
const SPEED_MIN = 0.7
const SPEED_MAX = 1.5

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

function extractEmotion(text: string): { emotion: string | null; cleanText: string } {
  const emotionPatterns = [
    /[【]([^】]+)[】]/,
    /[（(]([^)）]*(?:愤怒|生气|咆哮|怒吼|大喊|尖叫|悲伤|哭泣|哭诉|哽咽|抽泣|开心|高兴|兴奋|激动|欢笑|大笑|恐惧|害怕|惊恐|紧张|焦虑|温柔|轻声|低语|耳语|冷漠|冷淡|平静|沉思|犹豫|坚定|果断|惊讶|震惊|嘲讽|讽刺|撒娇|委屈|疲惫|叹息|叹气|急切|催促|警告|威胁|安慰|鼓励|感激|道歉|无奈|轻蔑|不屑|得意|骄傲|害羞|尴尬|痛苦|呻吟|喘息|微笑|冷笑|苦笑|微笑着|哭着|喊道|吼道|低声|大声|轻声|颤声|哽咽着|叹道|笑道)[^)）]*)[)）]/,
  ]
  for (const pattern of emotionPatterns) {
    const match = text.match(pattern)
    if (match) {
      const emotionText = match[1].trim()
      const cleanText = text.replace(pattern, '').trim()
      const emotionKeywords = ['愤怒','生气','咆哮','怒吼','大喊','尖叫','悲伤','哭泣','哭诉','哽咽','抽泣','开心','高兴','兴奋','激动','欢笑','大笑','恐惧','害怕','惊恐','紧张','焦虑','温柔','轻声','低语','耳语','冷漠','冷淡','平静','沉思','犹豫','坚定','果断','惊讶','震惊','嘲讽','讽刺','撒娇','委屈','疲惫','叹息','叹气','急切','催促','警告','威胁','安慰','鼓励','感激','道歉','无奈','轻蔑','不屑','得意','骄傲','害羞','尴尬','痛苦','呻吟','喘息']
      for (const kw of emotionKeywords) {
        if (emotionText.includes(kw)) return { emotion: kw, cleanText }
      }
      if (emotionText.includes('微笑') || emotionText.includes('笑')) return { emotion: '开心', cleanText }
      if (emotionText.includes('哭')) return { emotion: '悲伤', cleanText }
      if (emotionText.includes('喊') || emotionText.includes('叫')) return { emotion: '大喊', cleanText }
      if (emotionText.includes('吼')) return { emotion: '怒吼', cleanText }
      if (emotionText.includes('低声') || emotionText.includes('小声')) return { emotion: '轻声', cleanText }
      if (emotionText.includes('颤')) return { emotion: '紧张', cleanText }
    }
  }
  return { emotion: null, cleanText: text }
}

function parseDialogueForTTS(dialogue?: string | null) {
  const raw = dialogue?.trim() || ''
  if (!raw) return { speaker: '', pureText: '', emotion: null as string | null, ignorable: true }
  const pattern = /([^：:]+?)[：:]\s*([^：:]*?)(?=\s+[^：:]+?[：:]|$)/g
  const segments: { speaker: string; text: string; emotion: string | null }[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    const rawSpeaker = match[1].trim()
    const rawText = match[2].trim()
    const { emotion: speakerEmotion, cleanText: cleanSpeaker } = extractEmotion(rawSpeaker)
    const { emotion: textEmotion, cleanText: cleanText } = extractEmotion(rawText)
    const speaker = cleanSpeaker.replace(/[（(].+?[)）]/g, '').trim()
    const text = cleanText.replace(/[（(].+?[)）]/g, '').trim()
    const emotion = textEmotion || speakerEmotion
    if (speaker && text) segments.push({ speaker, text, emotion })
  }
  if (segments.length === 0) {
    const { emotion, cleanText } = extractEmotion(raw)
    const pureText = cleanText.replace(/[（(].+?[)）]/g, '').trim()
    if (!pureText || IGNORE_TTS_TEXT.test(pureText)) return { speaker: '', pureText: '', emotion: null, ignorable: true }
    return { speaker: '', pureText, emotion, ignorable: false }
  }
  const firstSpeaker = segments[0].speaker
  if (IGNORE_TTS_SPEAKERS.test(firstSpeaker)) {
    const nonIgnored = segments.find(s => !IGNORE_TTS_SPEAKERS.test(s.speaker))
    if (!nonIgnored) return { speaker: '', pureText: '', emotion: null, ignorable: true }
  }
  const pureText = segments.map(s => s.text).join(' ')
  const emotion = segments[0].emotion
  const ignorable = !pureText || IGNORE_TTS_TEXT.test(pureText)
  return { speaker: firstSpeaker, pureText, emotion, ignorable }
}

function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err || !meta.format?.duration) resolve(0)
      else resolve(Math.round(meta.format.duration * 1000) / 1000)
    })
  })
}

function generateSrtFromWordBoundaries(
  wordBoundaries: WordBoundary[],
  pureText: string,
  totalDurationSec: number
): string {
  if (wordBoundaries.length > 0) {
    const CHARS_PER_CUE = 10
    const cues: { startMs: number; endMs: number; text: string }[] = []
    let currentCueText = ''
    let currentCueStartMs = wordBoundaries[0].offsetMs
    let currentCueEndMs = 0

    for (let i = 0; i < wordBoundaries.length; i++) {
      const wb = wordBoundaries[i]
      currentCueText += wb.text
      currentCueEndMs = wb.offsetMs + wb.durationMs

      if (currentCueText.length >= CHARS_PER_CUE || i === wordBoundaries.length - 1) {
        cues.push({
          startMs: currentCueStartMs,
          endMs: currentCueEndMs,
          text: currentCueText,
        })
        currentCueText = ''
        if (i < wordBoundaries.length - 1) {
          currentCueStartMs = wordBoundaries[i + 1].offsetMs
        }
      }
    }

    const srtLines: string[] = []
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i]
      srtLines.push(`${i + 1}`)
      srtLines.push(`${fmtSrtTime(cue.startMs / 1000)} --> ${fmtSrtTime(cue.endMs / 1000)}`)
      srtLines.push(cue.text)
      srtLines.push('')
    }
    return srtLines.join('\n')
  }

  return generateSrtEvenSplit(pureText, totalDurationSec)
}

function generateSrtEvenSplit(pureText: string, totalDurationSec: number): string {
  const CHARS_PER_SEGMENT = 12
  const segments: string[] = []
  for (let i = 0; i < pureText.length; i += CHARS_PER_SEGMENT) {
    segments.push(pureText.slice(i, i + CHARS_PER_SEGMENT))
  }
  const totalSec = Math.max(totalDurationSec, 1)
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
  return srtLines.join('\n')
}

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
  let audioDurationMs = 0
  let wordBoundaries: WordBoundary[] = []
  const parsedDialogue = parseDialogueForTTS(sb.dialogue)

  try {
    // ── Phase 1: 生成 TTS 音频（音频优先） ──
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
          logTaskProgress('ComposeTask', 'generate-inline-tts', { storyboardId, voiceId, voiceProvider, emotion: parsedDialogue.emotion, textPreview: pureDialogue.slice(0, 40) })
          const ttsResult = await generateTTSWithMetadata({
            text: pureDialogue,
            voice: voiceId,
            configId: ep?.audioConfigId ?? undefined,
            voiceProvider,
            emotion: parsedDialogue.emotion || undefined,
          })
          audioPath = toAbsPath(ttsResult.relativePath)
          audioDurationMs = ttsResult.audioDurationMs
          wordBoundaries = ttsResult.wordBoundaries

          db.update(schema.storyboards).set({
            ttsAudioUrl: ttsResult.relativePath,
            ttsAudioDuration: audioDurationMs > 0 ? Math.round(audioDurationMs / 1000) : null,
            updatedAt: now(),
          }).where(eq(schema.storyboards.id, storyboardId)).run()

          logTaskProgress('ComposeTask', 'tts-duration', {
            storyboardId,
            audioDurationMs,
            wordBoundaries: wordBoundaries.length,
          })
        }
      } else {
        const probedAudioDuration = await probeDuration(audioPath)
        if (probedAudioDuration > 0) {
          audioDurationMs = probedAudioDuration * 1000
        }
      }
    }

    // ── Phase 2: 获取视频时长 ──
    let videoDurationSec = sb.duration || 10
    const probedVideoDuration = await probeDuration(videoPath)
    if (probedVideoDuration > 0) {
      videoDurationSec = probedVideoDuration
    }

    // ── Phase 3: 计算音画同步策略 ──
    let targetDurationSec = videoDurationSec
    let videoSpeed = 1.0
    let audioSpeed = 1.0

    if (audioDurationMs > 0) {
      const audioDurationSec = audioDurationMs / 1000
      const ratio = videoDurationSec / audioDurationSec

      if (ratio >= (1 - SPEED_ADJUST_THRESHOLD) && ratio <= (1 + SPEED_ADJUST_THRESHOLD)) {
        const speedFactor = videoDurationSec / audioDurationSec
        if (speedFactor >= SPEED_MIN && speedFactor <= SPEED_MAX) {
          videoSpeed = speedFactor
          targetDurationSec = audioDurationSec
          logTaskProgress('ComposeTask', 'sync-adjust-video-speed', {
            storyboardId,
            videoDurationSec,
            audioDurationSec,
            videoSpeed: videoSpeed.toFixed(3),
            strategy: 'video-adapts-to-audio',
          })
        } else {
          targetDurationSec = audioDurationSec
          logTaskProgress('ComposeTask', 'sync-no-adjust', {
            storyboardId,
            videoDurationSec,
            audioDurationSec,
            ratio: ratio.toFixed(2),
            reason: 'speed out of range, use audio duration as target',
          })
        }
      } else if (ratio > 1 + SPEED_ADJUST_THRESHOLD) {
        targetDurationSec = audioDurationSec
        logTaskProgress('ComposeTask', 'sync-trim-video', {
          storyboardId,
          videoDurationSec,
          audioDurationSec,
          strategy: 'video-too-long-trim-to-audio',
        })
      } else {
        const speedFactor = audioDurationSec / videoDurationSec
        if (speedFactor <= SPEED_MAX) {
          videoSpeed = 1 / speedFactor
          targetDurationSec = videoDurationSec * videoSpeed
          logTaskProgress('ComposeTask', 'sync-speed-up-video', {
            storyboardId,
            videoDurationSec,
            audioDurationSec,
            videoSpeed: videoSpeed.toFixed(3),
            strategy: 'audio-too-long-speed-up-video',
          })
        } else {
          targetDurationSec = audioDurationSec
          logTaskProgress('ComposeTask', 'sync-audio-too-long', {
            storyboardId,
            videoDurationSec,
            audioDurationSec,
            strategy: 'audio-much-longer-use-audio-duration',
          })
        }
      }
    }

    // ── Phase 4: 生成字幕文件（SRT）──
    if (!parsedDialogue.ignorable) {
      const srtDir = path.join(STORAGE_ROOT, 'subtitles')
      fs.mkdirSync(srtDir, { recursive: true })
      const srtFilename = `${uuid()}.srt`
      subtitlePath = path.join(srtDir, srtFilename)

      const pureText = parsedDialogue.pureText
      const srtContent = generateSrtFromWordBoundaries(wordBoundaries, pureText, targetDurationSec)
      fs.writeFileSync(subtitlePath, srtContent, 'utf-8')

      const srtRelative = `static/subtitles/${srtFilename}`
      db.update(schema.storyboards).set({ subtitleUrl: srtRelative, updatedAt: now() })
        .where(eq(schema.storyboards.id, storyboardId)).run()
    }

    // ── Phase 5: FFmpeg 合成（音画同步） ──
    const outputDir = path.join(STORAGE_ROOT, 'composed')
    fs.mkdirSync(outputDir, { recursive: true })
    const outputFilename = `${uuid()}.mp4`
    const outputPath = path.join(outputDir, outputFilename)

    await new Promise<void>((resolve, reject) => {
      let cmd = ffmpeg(videoPath)

      if (videoSpeed !== 1.0) {
        const setpts = 1 / videoSpeed
        cmd = cmd.videoFilter(`setpts=${setpts.toFixed(6)}*PTS`)
      }

      if (audioPath) {
        cmd = cmd.input(audioPath)
        if (audioSpeed !== 1.0) {
          cmd = cmd.audioFilter(`atempo=${audioSpeed.toFixed(3)}`)
        }
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
        if (videoSpeed !== 1.0) {
          const setpts = 1 / videoSpeed
          filters.unshift(`setpts=${setpts.toFixed(6)}*PTS`)
          cmd = ffmpeg(videoPath)
          if (audioPath) {
            cmd = cmd.input(audioPath)
          } else {
            cmd = cmd.input('anullsrc=channel_layout=stereo:sample_rate=48000')
            cmd = cmd.inputOptions(['-f', 'lavfi'])
          }
          cmd = cmd.videoFilter(filters.join(','))
        } else {
          cmd = cmd.videoFilter(filters)
        }
      }

      const outputOptions = [
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-map', '0:v',
        '-map', '1:a',
        '-c:a', 'aac',
        '-ar', '48000',
        '-ac', '2',
        '-shortest',
      ]

      if (targetDurationSec > 0 && audioPath) {
        outputOptions.push('-t', targetDurationSec.toFixed(3))
      }

      cmd.outputOptions(outputOptions)
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    })

    const composedRelative = `static/composed/${outputFilename}`
    db.update(schema.storyboards).set({
      composedVideoUrl: composedRelative,
      status: 'compose_completed',
      duration: Math.round(targetDurationSec),
      updatedAt: now(),
    }).where(eq(schema.storyboards.id, storyboardId)).run()

    logTaskSuccess('ComposeTask', 'storyboard-compose', {
      storyboardId,
      storyboardNumber: sb.storyboardNumber,
      output: composedRelative,
      videoDurationSec,
      audioDurationMs,
      videoSpeed: videoSpeed.toFixed(3),
      targetDurationSec: targetDurationSec.toFixed(2),
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
