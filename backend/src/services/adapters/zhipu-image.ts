import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { joinProviderUrl } from './url'

const ZHIPU_SIZE_MAP: Record<string, string> = {
  '1920x1080': '1344x768',
  '1080x1920': '768x1344',
  '1280x720': '1440x720',
  '720x1280': '720x1440',
  '1024x768': '1152x864',
  '768x1024': '864x1152',
}

function mapZhipuSize(size: string): string {
  if (ZHIPU_SIZE_MAP[size]) return ZHIPU_SIZE_MAP[size]
  const [w, h] = size.split('x').map(Number)
  if (!w || !h) return '1024x1024'
  const maxPx = Math.pow(2, 21)
  if (w * h <= maxPx && w % 16 === 0 && h % 16 === 0 && w >= 512 && h >= 512) return size
  if (w >= h) return '1344x768'
  return '768x1344'
}

export class ZhipuImageAdapter implements ImageProviderAdapter {
  provider = 'zhipu'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const size = mapZhipuSize(record.size || '1024x1024')

    const body: any = {
      model: record.model || 'cogview-3-flash',
      prompt: record.prompt,
      size,
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v4', '/images/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    if (result.task_id && result.task_status !== 'succeed') {
      return { isAsync: true, taskId: result.task_id }
    }
    const imageUrl = result.data?.[0]?.url || result.data?.[0]?.file_url
    if (imageUrl) {
      return { isAsync: false, imageUrl }
    }
    throw new Error('No image URL in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/v4', `/images/tasks/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    if (result.task_status === 'succeed' || result.status === 'completed') {
      return {
        status: 'completed',
        imageUrl: result.data?.[0]?.url || result.data?.[0]?.file_url || result.image_url || null,
      }
    }
    if (result.task_status === 'fail' || result.status === 'failed') {
      return { status: 'failed', error: result.error?.message || 'Generation failed' }
    }
    return { status: 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return result.data?.[0]?.url || result.data?.[0]?.file_url || null
  }

  extractImageBase64(): { data: string; mimeType: string } | null {
    return null
  }
}
