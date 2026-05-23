import Database from 'better-sqlite3'
import path from 'path'
const DB_PATH = path.resolve(process.cwd(), '../data/huobao_drama.db')
const db = new Database(DB_PATH)
const recent = db.prepare("SELECT id, storyboard_id, provider, model, status, error_msg, reference_mode, task_id, prompt FROM video_generations ORDER BY id DESC LIMIT 10").all()
console.log('Recent video generations:')
for (const r of recent) {
  console.log(`  #${r.id} sb=${r.storyboard_id} status=${r.status} model=${r.model} refMode=${r.reference_mode} taskId=${r.task_id}`)
  if (r.error_msg) console.log(`    ERROR: ${r.error_msg}`)
  console.log(`    PROMPT: ${r.prompt?.slice(0, 150)}...`)
}
db.close()
