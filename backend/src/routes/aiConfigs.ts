import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, notFound, created, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { joinProviderUrl } from '../services/adapters/url.js'
import { redactUrl, logTaskError, logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

function buildProbe(serviceType: string, provider: string, baseUrl: string, model?: string, apiKey?: string) {
  const url = joinProviderUrl(baseUrl, '/v1', '/models')
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return { method: 'GET', url, headers, body: undefined }
}

// GET /ai-configs?service_type=text
app.get('/', async (c) => {
  const serviceType = c.req.query('service_type')
  let rows = db.select().from(schema.aiServiceConfigs).all()
  if (serviceType) rows = rows.filter(r => r.serviceType === serviceType)

  const parsed = rows.map(r => ({
    ...toSnakeCase(r),
    model: r.model ? JSON.parse(r.model) : [],
  }))
  return success(c, parsed)
})

// POST /ai-configs
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()

  // 验证必填字段
  if (!body.service_type) {
    return badRequest(c, 'service_type is required')
  }

  const res = db.insert(schema.aiServiceConfigs).values({
    serviceType: body.service_type,
    provider: body.provider || 'openai',
    name: body.name || `${body.provider || 'openai'}-${body.service_type}`,
    baseUrl: body.base_url || '',
    apiKey: body.api_key || '',
    model: JSON.stringify(body.model || []),
    priority: body.priority || 0,
    isActive: true,
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const [row] = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, Number(res.lastInsertRowid))).all()

  return created(c, {
    ...toSnakeCase(row),
    model: row.model ? JSON.parse(row.model) : [],
  })
})

// POST /ai-configs/test
app.post('/test', async (c) => {
  const body = await c.req.json()
  if (!body.service_type) {
    return badRequest(c, 'service_type is required')
  }

  if (body.provider !== 'edge-tts' && !body.base_url) {
    return badRequest(c, 'base_url is required')
  }

  const provider = body.provider || 'openai'

  if (provider === 'edge-tts') {
    try {
      const resp = await fetch('https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4', {
        headers: {
          'Authority': 'speech.platform.bing.com',
          'Sec-CH-UA': '" Not;A Brand";v="99", "Microsoft Edge";v="143", "Chromium";v="143"',
          'Sec-CH-UA-Mobile': '?0',
          'Accept': '*/*',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'empty',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        },
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const voices = await resp.json() as any[]
      return success(c, {
        ok: true,
        reachable: true,
        status: 200,
        status_text: 'OK',
        method: 'WebSocket',
        url: 'Microsoft Edge TTS Service',
        message: `Edge TTS 服务可用，共 ${voices.length} 个音色`,
        response_preview: `可用音色: ${voices.filter((v: any) => v.Locale && v.Locale.startsWith('zh-')).length} 个中文音色`,
      })
    } catch (error: any) {
      return success(c, {
        ok: false,
        reachable: false,
        method: 'WebSocket',
        url: 'Microsoft Edge TTS Service',
        message: error.message || 'Edge TTS 服务不可用',
        response_preview: '',
      })
    }
  }

  const model = Array.isArray(body.model) ? body.model[0] : body.model
  const probe = buildProbe(body.service_type, provider, body.base_url, model, body.api_key)
  const probeUrl = redactUrl(probe.url)

  const curlCommand = `curl -X ${probe.method} '${probe.url}'${probe.headers.Authorization ? ` -H 'Authorization: ${probe.headers.Authorization}'` : ''}${probe.body ? ` -H 'Content-Type: application/json' -d '${JSON.stringify(probe.body)}'` : ''}`

  logTaskProgress('AIConfig', 'probe-start', {
    serviceType: body.service_type,
    provider,
    method: probe.method,
    url: probeUrl,
  })

  try {
    const resp = await fetch(probe.url, {
      method: probe.method,
      headers: probe.headers,
      body: probe.body ? JSON.stringify(probe.body) : undefined,
    })
    const text = await resp.text()
    const reachable = [200, 204, 400, 401, 403].includes(resp.status)
    const payload = {
      ok: resp.ok,
      reachable,
      status: resp.status,
      status_text: resp.statusText,
      method: probe.method,
      url: probeUrl,
      curl_command: curlCommand,
      message: reachable
        ? (resp.ok ? '端点可访问，认证与路径基本正常' : '端点已响应，请根据状态码判断认证或路径是否正确')
        : '端点未按预期响应，请检查 Base URL 和代理前缀',
      response_preview: text.slice(0, 240),
    }
    if (reachable) {
      logTaskSuccess('AIConfig', 'probe-done', {
        provider,
        status: resp.status,
        url: probeUrl,
      })
    } else {
      logTaskError('AIConfig', 'probe-unexpected', {
        provider,
        status: resp.status,
        url: probeUrl,
      })
    }
    return success(c, payload)
  } catch (error: any) {
    logTaskError('AIConfig', 'probe-failed', {
      provider,
      url: probeUrl,
      error: error.message,
    })
    return success(c, {
      ok: false,
      reachable: false,
      method: probe.method,
      url: probeUrl,
      curl_command: curlCommand,
      message: error.message || '请求失败',
      response_preview: '',
    })
  }
})

// GET /ai-configs/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id)).all()
  if (!row) return notFound(c)
  return success(c, {
    ...toSnakeCase(row),
    model: row.model ? JSON.parse(row.model) : [],
  })
})

// PUT /ai-configs/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [existing] = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id)).all()
  if (!existing) return notFound(c)
  const body = await c.req.json()
  const updates: Record<string, any> = { updatedAt: now() }

  if ('provider' in body) updates.provider = body.provider
  if ('name' in body) updates.name = body.name
  if ('base_url' in body) updates.baseUrl = body.base_url
  if ('api_key' in body) updates.apiKey = body.api_key
  if ('model' in body) updates.model = JSON.stringify(body.model)
  if ('priority' in body) updates.priority = body.priority
  if ('is_active' in body) updates.isActive = body.is_active

  db.update(schema.aiServiceConfigs).set(updates).where(eq(schema.aiServiceConfigs.id, id)).run()
  return success(c)
})

// DELETE /ai-configs/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id)).run()
  return success(c)
})

// GET /ai-providers
export const aiProviders = new Hono()
aiProviders.get('/', async (c) => {
  const rows = db.select().from(schema.aiServiceProviders).all()
  const parsed = rows.map(r => ({
    ...toSnakeCase(r),
    preset_models: r.presetModels ? JSON.parse(r.presetModels) : [],
  }))
  return success(c, parsed)
})

export default app
