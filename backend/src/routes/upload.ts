import { Hono } from 'hono'
import { success, badRequest } from '../utils/response.js'
import { saveUploadedFile } from '../utils/storage.js'

const app = new Hono()

// POST /upload/image
app.post('/image', async (c) => {
  const body = await c.req.parseBody()
  const file = body['file']
  const subDir = (body['sub_dir'] as string) || 'uploads'

  if (!file || !(file instanceof File)) {
    return badRequest(c, 'file is required')
  }

  const buffer = await file.arrayBuffer()
  const path = await saveUploadedFile(buffer, subDir, file.name)
  return success(c, { url: `/${path}`, path })
})

export default app
