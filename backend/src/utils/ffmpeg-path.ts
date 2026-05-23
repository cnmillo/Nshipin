import { createRequire } from 'module'
import path from 'path'

const require = createRequire(import.meta.url)

let ffmpegPath: string | null = null

function initFfmpegPath() {
  if (ffmpegPath) return
  try {
    const mod = require('@ffmpeg-installer/ffmpeg')
    if (mod.path) {
      ffmpegPath = String(mod.path)
      process.env.FFMPEG_PATH = ffmpegPath
      const dir = path.dirname(ffmpegPath)
      const existing = process.env.PATH || ''
      if (!existing.includes(dir)) {
        process.env.PATH = dir + ';' + existing
      }
    }
  } catch {}
}

initFfmpegPath()

export function findFfmpeg(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH
  if (ffmpegPath) return ffmpegPath
  return 'ffmpeg'
}

export function ensureFfmpeg() {
  initFfmpegPath()
}
