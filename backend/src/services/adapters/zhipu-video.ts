import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'

const ZHIPU_VIDEO_SIZES = ['1920x1080', '1080x1920', '1280x720', '720x1280', '1024x1024', '2048x1080', '3840x2160']

function mapZhipuVideoSize(size: string | null | undefined): string | undefined {
  if (!size) return undefined
  if (ZHIPU_VIDEO_SIZES.includes(size)) return size
  return undefined
}

export class ZhipuVideoAdapter implements VideoProviderAdapter {
  provider = 'zhipu'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = record.model || config.model || 'cogvideox-flash'
    const body: any = { model, prompt: record.prompt || '' }

    if (!mapZhipuVideoSize(record.aspectRatio)) {
      body.size = '1920x1080'
    } else {
      const size = mapZhipuVideoSize(record.aspectRatio)
      if (size) body.size = size
    }

    if (record.duration) body.duration = Math.min(record.duration, 10)
    else body.duration = 10

    if (record.referenceMode === 'single' && record.imageUrl) {
      body.image_url = record.imageUrl
    } else if (record.referenceMode === 'first_last') {
      const images: string[] = []
      if (record.firstFrameUrl) images.push(record.firstFrameUrl)
      if (record.lastFrameUrl) images.push(record.lastFrameUrl)
      if (images.length) body.image_url = images.length === 1 ? images[0] : images
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v4', '/videos/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const taskId = result.id || result.task_id
    if (taskId) {
      return { isAsync: true, taskId }
    }
    const videoUrl = result.video_url || result.video_result?.[0]?.url
    if (videoUrl) {
      return { isAsync: false, videoUrl }
    }
    throw new Error('No task_id or video_url in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/v4', `/async-result/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = (result.task_status || '').toUpperCase()
    if (status === 'SUCCESS') {
      const videoUrl = result.video_result?.[0]?.url || result.video_url
      return { status: 'completed', videoUrl }
    }
    if (status === 'FAIL') {
      return { status: 'failed', error: result.error_msg || result.error?.message || 'Video generation failed' }
    }
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return result.video_result?.[0]?.url || result.video_url || null
  }
}
