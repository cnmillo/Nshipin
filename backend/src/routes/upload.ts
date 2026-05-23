import { Hono } from 'hono'
import { success, badRequest } from '../utils/response.js'
import { saveUploadedFile } from '../utils/storage.js'

const app = new Hono()

// POST /upload/image
app.post('/image', async (c) => {
  const body = await c.req.parseBody()
  const file = body['file']
  const rawSubDir = (body['sub_dir'] as string) || 'uploads'

  if (!file || !(file instanceof File)) {
    return badRequest(c, 'file is required')
  }

  // 防止路径遍历
  if (rawSubDir.includes('..') || rawSubDir.includes('/') || rawSubDir.includes('\\')) {
    return badRequest(c, 'Invalid sub_dir')
  }

  const buffer = await file.arrayBuffer()
  const path = await saveUploadedFile(buffer, rawSubDir, file.name)
  return success(c, { url: `/${path}`, path })
})

export default app
