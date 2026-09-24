import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { safeGet } from '../safeFetch.js'

const UPLOADS_DIR = path.resolve('./data/uploads')

// MCP tools accept arbitrary URLs from the model on the user's behalf, so
// every fetch goes through lib/safeFetch.js (SSRF guard: no private/internal
// addresses, no redirects, DNS-rebinding-safe).

// The file extension controls what Content-Type express.static later serves
// this file as — deriving it from a Content-Type header (downloadMedia, set
// by whatever remote server the URL points to) or a caller-declared mimeType
// (saveBase64Media) without validation lets either one write a .html/.svg
// file into a static-served directory on the app's own origin, containing
// fully attacker-controlled bytes. That's stored XSS. Only ever write an
// extension from this fixed allowlist; anything else is rejected outright
// rather than falling back to a guess.
export const ALLOWED_MEDIA_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
}

function extensionFor(mimeType) {
  const ext = ALLOWED_MEDIA_TYPES[mimeType]
  if (!ext) throw new Error(`Unsupported media type: ${mimeType || '(none)'} — expected one of ${Object.keys(ALLOWED_MEDIA_TYPES).join(', ')}`)
  return ext
}

export async function downloadMedia(url) {
  const response = await safeGet(url, { responseType: 'stream' })

  const mimeType = response.headers['content-type']?.split(';')[0]
  let ext
  try {
    ext = extensionFor(mimeType)
  } catch (e) {
    response.data.destroy()
    throw e
  }
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`
  const filePath = path.join(UPLOADS_DIR, filename)

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(filePath)
    response.data.pipe(writer)
    writer.on('finish', resolve)
    writer.on('error', reject)
    response.data.on('error', reject)
  })

  return { filePath, mimeType, url: `${process.env.BASE_URL}/uploads/${filename}` }
}

const MAX_INLINE_MEDIA_BYTES = 45 * 1024 * 1024 // ~45MB decoded; keeps a single request well within the /mcp body limit

// For MCP clients with no way to host a file at a public URL — the file's
// bytes go straight through the tool call as base64. No network fetch
// involved, so none of downloadMedia's SSRF concerns apply here.
export function saveBase64Media(data, mimeType) {
  const buffer = Buffer.from(data, 'base64')
  if (buffer.length === 0) throw new Error('Empty or invalid base64 media data')
  if (buffer.length > MAX_INLINE_MEDIA_BYTES) {
    throw new Error(`Media too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB) — inline uploads are capped at ${MAX_INLINE_MEDIA_BYTES / 1024 / 1024}MB. Host it somewhere and pass a URL instead.`)
  }

  const ext = extensionFor(mimeType)
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`
  const filePath = path.join(UPLOADS_DIR, filename)
  fs.writeFileSync(filePath, buffer)

  return { filePath, mimeType, url: `${process.env.BASE_URL}/uploads/${filename}` }
}
