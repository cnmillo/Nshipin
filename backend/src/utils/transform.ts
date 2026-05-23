/**
 * 将 Drizzle 返回的 camelCase 对象转换为 snake_case
 * 保持前端 API 兼容（和旧 Go 后端一致）
 */
export function toSnakeCase(obj: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {}
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
    result[snakeKey] = value
  }
  return result
}

export function toSnakeCaseArray(arr: Record<string, any>[]): Record<string, any>[] {
  return arr.map(toSnakeCase)
}

/**
 * 视觉风格 → 提示词关键词映射
 * 用于角色图片、场景图片、宫格图、视频提示词
 */
const STYLE_KEYWORDS: Record<string, { character: string; scene: string; video: string }> = {
  realistic: {
    character: 'photorealistic, hyperrealistic, 8k uhd, natural skin texture, studio lighting',
    scene: 'photorealistic, hyperrealistic, 8k uhd, natural lighting, volumetric light',
    video: 'photorealistic, cinematic, natural motion',
  },
  anime: {
    character: 'anime style, cel-shaded, vibrant colors, clean lineart, Japanese animation',
    scene: 'anime style, cel-shaded, vibrant colors, Japanese animation background',
    video: 'anime style, cel-shaded animation, vibrant colors',
  },
  ghibli: {
    character: 'Studio Ghibli style, soft watercolor, whimsical, Miyazaki-inspired, hand-painted',
    scene: 'Studio Ghibli style, soft watercolor, whimsical, hand-painted background, lush nature',
    video: 'Studio Ghibli style, soft watercolor animation, whimsical',
  },
  cinematic: {
    character: 'cinematic, dramatic lighting, film grain, anamorphic lens, movie still',
    scene: 'cinematic, dramatic lighting, film grain, anamorphic lens, movie establishing shot',
    video: 'cinematic, dramatic lighting, film grain, anamorphic',
  },
  comic: {
    character: 'comic book style, bold outlines, halftone dots, dynamic shading, graphic novel',
    scene: 'comic book style, bold outlines, halftone dots, graphic novel background',
    video: 'comic book style, bold outlines, dynamic motion lines',
  },
  watercolor: {
    character: 'watercolor painting, soft edges, flowing colors, artistic, delicate brushstrokes',
    scene: 'watercolor painting, soft edges, flowing colors, artistic, delicate washes',
    video: 'watercolor painting style, soft flowing motion, artistic',
  },
}

export function getStyleKeywords(style: string, type: 'character' | 'scene' | 'video'): string {
  return STYLE_KEYWORDS[style]?.[type] || STYLE_KEYWORDS.realistic[type]
}
