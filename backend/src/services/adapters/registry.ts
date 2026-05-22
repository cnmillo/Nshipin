/**
 * Provider Adapter 注册表
 * 根据 provider 名称返回对应的 Adapter 实例
 */
import { MiniMaxImageAdapter } from './minimax-image'
import { MiniMaxVideoAdapter } from './minimax-video'
import { MiniMaxTTSAdapter } from './minimax-tts'
import { OpenAIImageAdapter } from './openai-image'
import { OpenAITTSAdapter } from './openai-tts'
import { GeminiImageAdapter } from './gemini-image'
import { VolcEngineImageAdapter } from './volcengine-image'
import { VolcEngineVideoAdapter } from './volcengine-video'
import { ViduVideoAdapter } from './vidu-video'
import { AliImageAdapter } from './ali-image'
import { ZhipuImageAdapter } from './zhipu-image'
import { SiliconFlowImageAdapter } from './siliconflow-image'
import { ZhipuVideoAdapter } from './zhipu-video'
import { AliVideoAdapter } from './ali-video'
import { EdgeTTSAdapter } from './edge-tts'
import type { ImageProviderAdapter, VideoProviderAdapter, TTSProviderAdapter } from './types'

// 图片 Adapter 注册表
export const imageAdapters: Record<string, ImageProviderAdapter> = {
  minimax: new MiniMaxImageAdapter(),
  openai: new OpenAIImageAdapter(),
  gemini: new GeminiImageAdapter(),
  volcengine: new VolcEngineImageAdapter(),
  ali: new AliImageAdapter(),
  zhipu: new ZhipuImageAdapter(),
  chatfire: new OpenAIImageAdapter(),
  siliconflow: new SiliconFlowImageAdapter(),
}

// 视频 Adapter 注册表
export const videoAdapters: Record<string, VideoProviderAdapter> = {
  minimax: new MiniMaxVideoAdapter(),
  volcengine: new VolcEngineVideoAdapter(),
  vidu: new ViduVideoAdapter(),
  ali: new AliVideoAdapter(),
  zhipu: new ZhipuVideoAdapter(),
  siliconflow: new MiniMaxVideoAdapter(),
}

// TTS Adapter 注册表
export const ttsAdapters: Record<string, TTSProviderAdapter> = {
  minimax: new MiniMaxTTSAdapter(),
  openai: new OpenAITTSAdapter(),
  'edge-tts': new EdgeTTSAdapter(),
}

export function getTTSAdapter(provider: string): TTSProviderAdapter {
  return ttsAdapters[provider.toLowerCase()] || ttsAdapters['openai']
}

/**
 * 获取图片 Adapter
 * @param provider 厂商名称
 * @returns 对应的 Adapter，未知厂商返回 MiniMax 默认
 */
export function getImageAdapter(provider: string): ImageProviderAdapter {
  return imageAdapters[provider.toLowerCase()] || imageAdapters['minimax']
}

/**
 * 获取视频 Adapter
 * @param provider 厂商名称
 * @returns 对应的 Adapter，未知厂商返回 MiniMax 默认
 */
export function getVideoAdapter(provider: string): VideoProviderAdapter {
  return videoAdapters[provider.toLowerCase()] || videoAdapters['minimax']
}
