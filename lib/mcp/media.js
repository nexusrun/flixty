import axios from 'axios'
import http from 'http'
import https from 'https'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import dns from 'dns'
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

// A DNS-rebinding-safe resolver: validating the address from a separate
// dns.lookup() call and then letting the HTTP client re-resolve the hostname
// itself on connect leaves a TOCTOU window (the DNS record can change
// between the two lookups). This is wired in as the Agent's own `lookup`,
// making it the *only* resolution Node performs — it connects to exactly the
// address validated here, so there's no second lookup for an attacker to
// race. (Verified this actually fires for hostname targets — axios's own
// `lookup` config option is wrapped through an internal compatibility shim
// that did not invoke it in testing, so this goes through a real
// http.Agent/https.Agent instead, which is the mechanism Node itself uses.)
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {} }
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err)
    try {
      // With { all: true } (Node's Happy Eyeballs / autoSelectFamily connect
      // path), `address` is an array of { address, family } — validate every
      // candidate rather than assuming a single string.
      if (Array.isArray(address)) {
        for (const entry of address) assertPublicHost(hostname, entry.address)
      } else {
        assertPublicHost(hostname, address)
      }
    } catch (e) {
      return callback(e)
    }
    callback(null, address, family)
  })
}

const httpAgent = new http.Agent({ lookup: safeLookup })
const httpsAgent = new https.Agent({ lookup: safeLookup })

export async function downloadMedia(url) {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http(s) URLs are supported')

  // Literal IP in the URL means no DNS resolution happens at all (the
  // `lookup` hook above is never invoked for these), so it has to be
  // validated directly — there's no rebinding risk here since there's no
  // DNS involved, just a plain address to check once.
  const bareHost = parsed.hostname.replace(/^\[|\]$/g, '') // strip [] from IPv6 literals
  if (net.isIP(bareHost)) assertPublicHost(bareHost, bareHost)

  const response = await axios.get(url, {
    responseType: 'stream',
    maxRedirects: 0, // a redirect would otherwise need its own lookup/validation
    timeout: 20000,
    maxContentLength: 100 * 1024 * 1024,
    httpAgent,
    httpsAgent,
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

  const ext = (mimeType || 'application/octet-stream').split('/')[1]?.split(';')[0] || 'bin'
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`
  const filePath = path.join(UPLOADS_DIR, filename)
  fs.writeFileSync(filePath, buffer)

  return { filePath, mimeType: mimeType || 'application/octet-stream', url: `${process.env.BASE_URL}/uploads/${filename}` }
}
