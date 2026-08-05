import axios from 'axios'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import dns from 'dns/promises'
import net from 'net'

const UPLOADS_DIR = path.resolve('./data/uploads')

// MCP tools accept arbitrary URLs from the model on the user's behalf — this
// is the one place in the app that fetches a URL supplied by an MCP client,
// so it's worth guarding against SSRF (cloud metadata endpoints, internal
// services) rather than trusting axios to only ever hit the public internet.
function assertPublicHost(hostname, address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number)
    const isPrivate =
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 127 ||
      (a === 169 && b === 254) || // link-local, includes cloud metadata (169.254.169.254)
      a === 0
    if (isPrivate) throw new Error(`Refusing to fetch from private address: ${hostname} -> ${address}`)
  } else {
    const lower = address.toLowerCase()
    if (lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) {
      throw new Error(`Refusing to fetch from private address: ${hostname} -> ${address}`)
    }
  }
}

export async function downloadMedia(url) {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http(s) URLs are supported')

  const { address } = await dns.lookup(parsed.hostname)
  assertPublicHost(parsed.hostname, address)

  const response = await axios.get(url, {
    responseType: 'stream',
    maxRedirects: 0, // avoid a redirect silently landing on an internal address
    timeout: 20000,
    maxContentLength: 100 * 1024 * 1024,
  })

  const mimeType = response.headers['content-type']?.split(';')[0] || 'application/octet-stream'
  const ext = mimeType.split('/')[1] || 'bin'
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
