import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '../data')
const STORE_PATH = path.join(DATA_DIR, 'store.json')

function read() {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.writeFileSync(STORE_PATH, JSON.stringify({ tokens: {}, posts: [], scheduled: [] }, null, 2))
    }
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
  } catch {
    return { tokens: {}, posts: [], scheduled: [] }
  }
}

function write(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2))
}

export const getTokens = () => read().tokens
export function saveToken(platform, data) {
  const s = read(); s.tokens[platform] = { ...data, savedAt: Date.now() }; write(s)
}
export function removeToken(platform) {
  const s = read(); delete s.tokens[platform]; write(s)
}

export const getPosts = () => read().posts
export function savePost(post) {
  const s = read()
  const item = { ...post, id: Date.now(), createdAt: new Date().toISOString() }
  s.posts.unshift(item); write(s); return item
}

export const getScheduled = () => read().scheduled
export function saveScheduled(post) {
  const s = read()
  const item = { ...post, id: Date.now(), createdAt: new Date().toISOString() }
  s.scheduled.push(item); write(s); return item
}
export function removeScheduled(id) {
  const s = read(); s.scheduled = s.scheduled.filter(p => p.id !== id); write(s)
}
