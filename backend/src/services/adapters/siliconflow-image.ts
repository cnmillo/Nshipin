import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { joinProviderUrl } from './url'

const SF_IMAGE_SIZES = ['1024x1024', '960x1280', '768x1024', '720x1440', '720x1280']

function mapSfSize(size: string | null | undefined): string {
  if (!size) return '1024x1024'
  if (SF_IMAGE_SIZES.includes(size)) return size
  const [w, h] = size.split('x').map(Number)
  if (isNaN(w) || isNaN(h)) return '1024x1024'
  const ratio = w / h
  if (Math.abs(ratio - 1) < 0.1) return '1024x1024'
  if (ratio > 1.4) return '720x1280'
  if (ratio > 1.2) return '720x1440'
  if (ratio > 1) return '960x1280'
  if (ratio > 0.7) return '768x1024'
  return '720x1440'
}

export class SiliconFlowImageAdapter implements ImageProviderAdapter {
  provider = 'siliconflow'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const body: any = {
      model: record.model || config.model,
      prompt: record.prompt,
      image_size: mapSfSize(record.size),
    }

    if (record.referenceImages?.length) {
      const refs = JSON.parse(record.referenceImages)
      if (Array.isArray(refs) && refs.length) body.image = refs[0]
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/images/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    if (result.images?.length) {
      const img = result.images[0]
      const url = img.url || img.b64_json
      if (!url) throw new Error('No url or b64_json in response')
      return { isAsync: false, imageUrl: url }
    }
    if (result.data?.length) {
      const img = result.data[0]
      const url = img.url || img.b64_json
      if (!url) throw new Error('No url or b64_json in response')
      return { isAsync: false, imageUrl: url }
    }
    throw new Error('No image data in response')
  }

  buildPollRequest(_config: AIConfig, _taskId: string): ProviderRequest {
    throw new Error('SiliconFlow image generation is synchronous')
  }

  parsePollResponse(_result: any): ImagePollResponse {
    return { status: 'completed' }
  }

  extractImageUrl(result: any): string | null {
    return result.images?.[0]?.url || result.data?.[0]?.url || null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const b64 = result.images?.[0]?.b64_json || result.data?.[0]?.b64_json
    return b64 ? { data: b64, mimeType: 'image/png' } : null
  }
}
