import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'

export interface StyleConfig {
  label: string
  imagePrompt: string
  videoPrompt: string
  negativePrompt: string
}

const styleMap: Record<string, StyleConfig> = {
  realistic: {
    label: '写实',
    imagePrompt: 'photorealistic, hyper-realistic, 8k uhd, DSLR quality, natural lighting, sharp focus, detailed textures, lifelike skin, real photography',
    videoPrompt: 'cinematic realism, natural motion, photorealistic quality, smooth camera movement',
    negativePrompt: 'anime, cartoon, illustration, painting, drawing, sketch, CGI, 3d render, artificial, plastic',
  },
  anime: {
    label: '动漫',
    imagePrompt: 'anime style, Japanese animation, cel-shaded, vibrant colors, clean lineart, detailed anime eyes, expressive features, studio quality anime',
    videoPrompt: 'anime animation style, fluid anime motion, cel-shaded, vibrant colors',
    negativePrompt: 'photorealistic, photo, realistic, 3d render, western cartoon, rough sketch, blurry',
  },
  ghibli: {
    label: '吉卜力',
    imagePrompt: 'Studio Ghibli style, Miyazaki inspired, hand-painted watercolor background, soft pastel colors, whimsical atmosphere, detailed nature, warm lighting, dreamy',
    videoPrompt: 'Studio Ghibli animation, hand-drawn feel, soft watercolor motion, gentle movement',
    negativePrompt: 'photorealistic, dark, horror, gritty, realistic photo, CGI, 3d render, modern anime',
  },
  cinematic: {
    label: '电影感',
    imagePrompt: 'cinematic, film grain, dramatic lighting, anamorphic lens flare, shallow depth of field, color graded, movie still, 35mm film, moody atmosphere, volumetric lighting',
    videoPrompt: 'cinematic camera movement, film grain, dramatic lighting, movie-like quality, slow motion',
    negativePrompt: 'cartoon, anime, illustration, flat lighting, amateur, phone camera, low quality',
  },
  comic: {
    label: '漫画',
    imagePrompt: 'comic book style, bold outlines, halftone dots, dynamic composition, high contrast, vibrant ink colors, graphic novel art, panel art style',
    videoPrompt: 'comic book animation, bold outlines, dynamic motion lines, high contrast',
    negativePrompt: 'photorealistic, photo, realistic, watercolor, soft, blurry, muted colors',
  },
  watercolor: {
    label: '水彩',
    imagePrompt: 'watercolor painting, soft wash, wet on wet technique, delicate brushstrokes, pastel palette, artistic, flowing colors, paper texture, gentle gradients',
    videoPrompt: 'watercolor animation, soft flowing motion, gentle transitions, artistic feel',
    negativePrompt: 'photorealistic, photo, sharp edges, digital, CGI, harsh lines, dark, gritty',
  },
}

export function getStyleConfig(style: string | null | undefined): StyleConfig {
  return styleMap[style || 'realistic'] || styleMap.realistic
}

export function applyStyleToImagePrompt(prompt: string, style: string | null | undefined): string {
  const config = getStyleConfig(style)
  if (!style || style === 'realistic') return prompt
  return `${prompt}, ${config.imagePrompt}`
}

export function applyStyleToVideoPrompt(prompt: string, style: string | null | undefined): string {
  const config = getStyleConfig(style)
  if (!style || style === 'realistic') return prompt
  return `${prompt}, ${config.videoPrompt}`
}

export function getStyleNegativePrompt(style: string | null | undefined): string {
  const config = getStyleConfig(style)
  return config.negativePrompt
}

export function getDramaStyle(dramaId: number | null | undefined): string | null {
  if (!dramaId) return null
  const [drama] = db.select({ style: schema.dramas.style }).from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all()
  return drama?.style || null
}
