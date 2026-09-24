import axios from 'axios'
import http from 'http'
import https from 'https'
import dns from 'dns'
import net from 'net'

// SSRF guard for every URL the server fetches on a user's behalf — MCP media
// URLs, a user's custom AI provider base URL, and the image/video URLs an AI
// provider hands back. Any of these can point at cloud metadata endpoints
// (169.254.169.254) or services on the private network, so private,
// loopback, link-local and other non-public ranges are refused.
const blocked = new net.BlockList()
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4')
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(addr, prefix, 'ipv6')

function isBlockedAddress(address) {
  if (net.isIPv4(address)) return blocked.check(address, 'ipv4')
  const lower = address.toLowerCase()
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) reaches the IPv4 address it wraps
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return blocked.check(mapped[1], 'ipv4')
  return blocked.check(lower, 'ipv6')
}

export function assertPublicAddress(hostname, address) {
  if (isBlockedAddress(address)) throw new Error(`Refusing to connect to private address: ${hostname} -> ${address}`)
}

// A DNS-rebinding-safe resolver: validating the address from a separate
// dns.lookup() call and then letting the HTTP client re-resolve the hostname
// itself on connect leaves a TOCTOU window (the DNS record can change
// between the two lookups). This is wired in as the Agent's own `lookup`,
// making it the *only* resolution Node performs — it connects to exactly the
// address validated here, so there's no second lookup for an attacker to
// race. (axios's own `lookup` config option is wrapped through an internal
// compatibility shim that did not invoke it in testing, so this goes through
// a real http.Agent/https.Agent instead.)
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {} }
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err)
    try {
      // With { all: true } (Happy Eyeballs), `address` is an array — check every candidate.
      if (Array.isArray(address)) {
        for (const entry of address) assertPublicAddress(hostname, entry.address)
      } else {
        assertPublicAddress(hostname, address)
      }
    } catch (e) {
      return callback(e)
    }
    callback(null, address, family)
  })
}

export const safeHttpAgent = new http.Agent({ lookup: safeLookup })
export const safeHttpsAgent = new https.Agent({ lookup: safeLookup })

// Literal-IP URLs never go through DNS (the lookup hook above isn't invoked),
// so they have to be checked directly.
function assertUrlShape(url) {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http(s) URLs are supported')
  const bareHost = parsed.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(bareHost)) assertPublicAddress(bareHost, bareHost)
  return parsed
}

// For URLs fetched by code that can't take a custom agent (global fetch, the
// Anthropic SDK): resolve now and refuse if any address is private. This
// leaves a small DNS-rebinding window between this check and the real
// connection, so anything whose response is read back or stored should use
// safeDownload instead.
export async function assertPublicUrl(url) {
  const parsed = assertUrlShape(url)
  const bareHost = parsed.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(bareHost)) return
  const addresses = await dns.promises.lookup(bareHost, { all: true })
  for (const { address } of addresses) assertPublicAddress(bareHost, address)
}

// Fetch a URL through the rebinding-safe agents, with no redirects (each hop
// would need its own validation). Resolves to an axios response.
export function safeGet(url, { responseType = 'arraybuffer', timeout = 20000, maxContentLength = 100 * 1024 * 1024, headers } = {}) {
  assertUrlShape(url)
  return axios.get(url, {
    responseType, timeout, maxContentLength, headers,
    maxRedirects: 0,
    httpAgent: safeHttpAgent,
    httpsAgent: safeHttpsAgent,
  })
}

// Private base URLs are legitimate in local development (e.g. a model relay
// on localhost) — allowed only when explicitly opted in.
export const allowPrivateAiUrls = () => process.env.ALLOW_PRIVATE_AI_URLS === 'true'
