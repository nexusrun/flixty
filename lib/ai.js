import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import { getAiSettings } from './store.js'
import { assertPublicUrl, safeGet, allowPrivateAiUrls } from './safeFetch.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const execFileP = promisify(execFile)

// Provider defaults. Anthropic uses its official SDK. OpenAI, Gemini, and
// OpenRouter all expose an OpenAI-compatible Chat Completions endpoint, so the
// same streaming and completion code can be used for each provider.
const DEFAULTS = {
  // anthropic uses the SDK default endpoint (no env base-URL override — the
  // original code never read one); a custom URL is set per-user in AI Settings.
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-4-6',
    envKey: () => process.env.ANTHROPIC_API_KEY,
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-3.5-sonnet',
    imageModel: 'black-forest-labs/flux-schnell',
    envKey: () => process.env.OPENROUTER_API_KEY,
    envBaseUrl: () => process.env.OPENROUTER_BASE_URL,
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5',
    imageModel: 'gpt-image-1',
    envKey: () => process.env.OPENAI_API_KEY,
    envBaseUrl: () => process.env.OPENAI_BASE_URL,
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.6-flash',
    envKey: () => process.env.GEMINI_API_KEY,
    envBaseUrl: () => process.env.GEMINI_BASE_URL,
  },
}

export const PROVIDERS = new Set(Object.keys(DEFAULTS))

// A user-supplied provider base URL is a URL the server will POST to on that
// user's behalf — refuse private/internal addresses (cloud metadata, services
// on the private network) unless ALLOW_PRIVATE_AI_URLS=true (local relays in
// development).
export async function assertSafeBaseUrl(baseUrl) {
  if (allowPrivateAiUrls()) return
  try {
    await assertPublicUrl(baseUrl)
  } catch (e) {
    throw new Error(`AI provider URL not allowed: ${e.message}`)
  }
}

// Effective config for a user: per-user settings win, env vars are the fallback
// when the user hasn't saved their own key/URL/model. A custom base URL is
// validated here so every provider call is covered; pass checkBaseUrl: false
// only for read-only uses (showing the settings form).
export async function resolveAiConfig(userId, { checkBaseUrl = true } = {}) {
  const row = await getAiSettings(userId)
  const provider = row?.provider && PROVIDERS.has(row.provider) ? row.provider : 'anthropic'
  const d = DEFAULTS[provider]
  if (checkBaseUrl && row?.base_url) await assertSafeBaseUrl(normalizeBaseUrl(provider, row.base_url))
  return {
    provider,
    apiKey: row?.api_key || d.envKey(),
    baseUrl: normalizeBaseUrl(provider, row?.base_url || d.envBaseUrl?.() || d.baseUrl),
    model: normalizeModel(provider, row?.model || d.model),
    imageModel: row?.image_model || d.imageModel,
  }
}

// Users often paste the provider origin instead of the API base path. Make
// the documented defaults forgiving without changing arbitrary custom proxy
// URLs.
function normalizeBaseUrl(provider, value) {
  let base = String(value || '').replace(/\/+$/, '')
  if (provider === 'anthropic' && base === 'https://api.anthropic.com/v1') return 'https://api.anthropic.com'
  if (provider === 'openai' && base === 'https://api.openai.com') return `${base}/v1`
  if (provider === 'openrouter' && base === 'https://openrouter.ai') return `${base}/api/v1`
  if (provider === 'gemini' && base === 'https://generativelanguage.googleapis.com') return `${base}/v1beta`
  return base
}

function normalizeModel(provider, value) {
  let model = String(value || '').trim()
  if (provider === 'gemini') {
    // A model ID copied from prose often includes a trailing sentence period
    // or the optional "models/" resource prefix.
    model = model.replace(/^models\//, '').replace(/[\s.]+$/, '')
  }
  return model
}

function missingKeyError(provider) {
  const names = {
    anthropic: 'ANTHROPIC_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    openai: 'OPENAI_API_KEY',
    gemini: 'GEMINI_API_KEY',
  }
  const name = names[provider] || `${provider} API key`
  return new Error(`${name} is not set — add it in AI Settings or the server .env.`)
}

async function readProviderError(res, endpoint = '') {
  const body = await res.text().catch(() => '')
  let detail = ''
  try { const j = JSON.parse(body); detail = j.error?.message || j.message || '' } catch { /* not json */ }
  return `AI provider returned ${res.status}${detail ? `: ${detail}` : ''}${endpoint ? ` (${endpoint})` : ''}`
}

const chatCompletionsUrl = baseUrl => `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`
const completionTokenParam = (provider, maxTokens) =>
  provider === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }

function geminiBaseUrl(baseUrl) {
  return String(baseUrl).replace(/\/openai\/?$/, '').replace(/\/+$/, '')
}

function geminiContents(messages = []) {
  return messages
    .filter(message => message.role !== 'system')
    .map(message => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }],
    }))
}

function geminiRequest(cfg, { system, messages, maxTokens }, stream) {
  const action = stream ? 'streamGenerateContent?alt=sse&key=' : 'generateContent?key='
  const endpoint = `${geminiBaseUrl(cfg.baseUrl)}/models/${encodeURIComponent(cfg.model)}:${action}${encodeURIComponent(cfg.apiKey)}`
  return {
    endpoint,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: geminiContents(messages),
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    },
  }
}

// Stream a chat completion, calling onText(text) for each chunk of content.
// Supported providers: anthropic (SDK), and OpenAI-compatible SSE providers.
export async function streamAiText(cfg, { system, messages, maxTokens = 1024 }, onText) {
  if (!cfg.apiKey) throw missingKeyError(cfg.provider)

  if (cfg.provider === 'gemini') {
    const request = geminiRequest(cfg, { system, messages, maxTokens }, true)
    const res = await fetch(request.endpoint, request.init)
    if (!res.ok) throw new Error(await readProviderError(res, request.endpoint))
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        try {
          const json = JSON.parse(trimmed.slice(5).trim())
          const text = json.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('')
          if (text) onText(text)
        } catch { /* wait for the next complete SSE event */ }
      }
    }
    return
  }

  if (cfg.provider === 'anthropic') {
    const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl })
    const stream = client.messages.stream({
      model: cfg.model,
      max_tokens: maxTokens,
      // No extended thinking: these are short rewrite/generation tasks with
      // tight max_tokens budgets (as low as 512), and thinking tokens count
      // against that budget — posts came back truncated or empty.
      system,
      messages,
    })
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        onText(event.delta.text)
      }
    }
    return
  }

  const res = await fetch(chatCompletionsUrl(cfg.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      ...completionTokenParam(cfg.provider, maxTokens),
      stream: true,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages,
      ],
    }),
  })
  if (!res.ok) throw new Error(await readProviderError(res, chatCompletionsUrl(cfg.baseUrl)))

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const json = JSON.parse(payload)
        const delta = json.choices?.[0]?.delta?.content
        if (delta) onText(delta)
      } catch { /* partial chunk — wait for more */ }
    }
  }
}

// Non-streaming completion returning the full text.
export async function completeAiText(cfg, { system, messages, maxTokens = 256 }) {
  if (!cfg.apiKey) throw missingKeyError(cfg.provider)

  if (cfg.provider === 'gemini') {
    const request = geminiRequest(cfg, { system, messages, maxTokens }, false)
    const res = await fetch(request.endpoint, request.init)
    if (!res.ok) throw new Error(await readProviderError(res, request.endpoint))
    const json = await res.json()
    return json.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || ''
  }

  if (cfg.provider === 'anthropic') {
    const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl })
    const response = await client.messages.create({
      model: cfg.model,
      max_tokens: maxTokens,
      system,
      messages,
    })
    return response.content.find(b => b.type === 'text')?.text ?? ''
  }

  const res = await fetch(chatCompletionsUrl(cfg.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      ...completionTokenParam(cfg.provider, maxTokens),
      stream: false,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages,
      ],
    }),
  })
  if (!res.ok) throw new Error(await readProviderError(res, chatCompletionsUrl(cfg.baseUrl)))
  const json = await res.json()
  return json.choices?.[0]?.message?.content ?? ''
}

// Generate an image and return the raw bytes. OpenAI and OpenRouter expose an
// OpenAI-compatible image endpoint. Gemini's compatibility layer is text-only
// for this app, and Anthropic has no image-generation endpoint.
export async function generateImage(cfg, { prompt, size = '1024x1024' }) {
  if (!['openrouter', 'openai'].includes(cfg.provider)) {
    throw new Error('AI image generation requires OpenAI or OpenRouter. Switch the provider in AI Settings.')
  }
  if (!cfg.apiKey) throw missingKeyError(cfg.provider)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120000)
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({ model: cfg.imageModel, prompt, n: 1, size }),
    })
    if (!res.ok) throw new Error(await readProviderError(res))

    const json = await res.json()
    const item = json.data?.[0]
    if (item?.b64_json) return Buffer.from(item.b64_json, 'base64')
    if (item?.url) {
      // The URL comes from the provider's response — fetched through the SSRF
      // guard, since a custom provider could point it anywhere.
      try {
        const img = await safeGet(item.url, { timeout: 60000, maxContentLength: 50 * 1024 * 1024 })
        return Buffer.from(img.data)
      } catch (e) {
        throw new Error(`Failed to download generated image: ${e.response ? `HTTP ${e.response.status}` : e.message}`)
      }
    }
    throw new Error('Image provider response had neither b64_json nor url.')
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Image generation timed out after 120 seconds.')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// ── AI video generation ──────────────────────────────────────────────────────
//
// Two strategies, tried in order:
//
//  1. Real text-to-video through the configured provider when its model is a
//     video model (e.g. veo-free/veo). Uses the OpenAI-compatible generations
//     contract (POST {base}/video/generations) with a chat-completions fallback,
//     because some relays (like a local Nexus proxy) serve video models through
//     /chat/completions and return the clip URL after a long generation.
//
//  2. Image-compose (the original approach): generate AI images from the prompt
//     and assemble them into an MP4 with ffmpeg — used when the provider has no
//     video model.

const VIDEO_MODEL_RE = /(veo|seedance|kling|pika|wan|sora|movie|video|generate-00)/i

export function isVideoModel(model) {
  return typeof model === 'string' && VIDEO_MODEL_RE.test(model)
}

// How long a text-to-video generation request may take before we give up. Veo-
// class models routinely take a few minutes, and some relays hold the HTTP
// connection open for the whole generation. Override with VIDEO_API_TIMEOUT_MS.
const VIDEO_API_TIMEOUT_MS = Number(process.env.VIDEO_API_TIMEOUT_MS) || 12 * 60 * 1000
const VIDEO_EP_TIMEOUT_MS = 90 * 1000

// Raised when the provider has no usable text-to-video path — the caller falls
// back to the image-compose strategy instead of surfacing it as an error.
class VideoNotSupportedError extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchWithTimeout(url, init = {}, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`AI video request timed out after ${Math.round(timeoutMs / 1000)}s.`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// Pull the first http(s) URL out of a provider response, whatever shape it used,
// preferring direct media-file links (.mp4/.webm/.mov) over HTML pages.
function extractVideoUrl(json) {
  const found = []
  const walk = node => {
    if (!node) return
    if (typeof node === 'string') {
      const m = node.match(/https?:\/\/[^\s"'<>]+/i)
      if (m) found.push(m[0])
      return
    }
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string' && /(url|video|href|link|src|content)/i.test(k)) {
          const m = v.match(/https?:\/\/[^\s"'<>]+/i)
          if (m) found.push(m[0])
        }
        walk(v)
      }
    }
  }
  walk(json)
  const isMedia = u => /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(u)
  found.sort((a, b) => (isMedia(a) ? -1 : 1) - (isMedia(b) ? -1 : 1))
  return found[0] || null
}

// Download a video URL and make sure the bytes actually look like video before
// handing them on — relays sometimes point at an HTML page instead of the clip.
async function downloadVideo(url) {
  // Provider-supplied URL — fetched through the SSRF guard.
  let buf
  try {
    const res = await safeGet(url, { timeout: 5 * 60 * 1000, maxContentLength: 500 * 1024 * 1024 })
    buf = Buffer.from(res.data)
  } catch (e) {
    throw new Error(`Failed to download generated video: ${e.response ? `HTTP ${e.response.status}` : e.message}`)
  }
  const isMp4 = buf.length > 8 && buf.subarray(4, 8).toString('latin1') === 'ftyp'
  const isWebm = buf.length > 4 && buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  if (!isMp4 && !isWebm) {
    throw new Error('The AI provider returned something that is not a video file.')
  }
  return buf
}

// Poll a provider-side text-to-video job until it completes, returning the video
// URL. Understands both a relative status path and an absolute status_url.
async function pollVideoJob(base, apiKey, job) {
  const id = job.id || job.job_id
  const statusUrl = job.status_url || job.statusUrl
  const pollUrl = statusUrl || `${base}/video/generations/${id}`
  // An absolute status_url comes from the provider's response, and the poll
  // sends the API key with it.
  if (statusUrl) await assertSafeBaseUrl(statusUrl)
  const deadline = Date.now() + VIDEO_API_TIMEOUT_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error('Video generation timed out while waiting for the provider job.')
    await sleep(5000)
    const r = await fetchWithTimeout(pollUrl, { headers: { Authorization: `Bearer ${apiKey}` } }, VIDEO_EP_TIMEOUT_MS)
    if (!r.ok) throw new Error(await readProviderError(r))
    const j = await r.json().catch(() => ({}))
    const status = String(j.status || '').toLowerCase()
    if (['succeeded', 'complete', 'completed', 'done'].includes(status)) {
      const url = extractVideoUrl(j)
      if (url) return url
      throw new Error('The AI provider reported the video job complete but gave no video URL.')
    }
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      throw new Error(`Video generation failed: ${j.error?.message || j.message || status}`)
    }
  }
}

// Ask the provider for a real text-to-video clip and return the raw video bytes.
// Throws VideoNotSupportedError when the provider has no usable video path.
async function requestTextToVideo(cfg, { prompt, aspectRatio, duration }) {
  if (!['openrouter', 'openai'].includes(cfg.provider) || !cfg.apiKey) {
    throw new VideoNotSupportedError('The configured provider has no OpenAI-compatible video API.')
  }
  const base = String(cfg.baseUrl).replace(/\/+$/, '')
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` }
  const body = { model: cfg.model, prompt }
  if (aspectRatio) body.aspect_ratio = aspectRatio
  if (duration) body.duration = duration

  // 1) Dedicated generations endpoint (OpenAI images-style contract).
  const r = await fetchWithTimeout(
    `${base}/video/generations`,
    { method: 'POST', headers, body: JSON.stringify(body) },
    VIDEO_EP_TIMEOUT_MS,
  )
  if (r.status === 404 || r.status === 405) {
    // Route missing — some relays don't expose one; try chat-completions below.
  } else if (!r.ok) {
    throw new Error(`AI video provider returned ${r.status}: ${await readProviderError(r)}`)
  } else {
    const json = await r.json().catch(() => ({}))
    if (json.data?.[0]?.b64_json) return Buffer.from(json.data[0].b64_json, 'base64')
    const status = String(json.status || '').toLowerCase()
    if (status && !['succeeded', 'complete', 'completed', 'done'].includes(status)) {
      return downloadVideo(await pollVideoJob(base, cfg.apiKey, json))
    }
    const url = extractVideoUrl(json)
    if (url) return downloadVideo(url)
    throw new VideoNotSupportedError('video/generations answered without a video URL or job id.')
  }

  // 2) Chat-completions fallback — some relays serve video models through
  //    /chat/completions and return the clip URL after a long generation.
  const r2 = await fetchWithTimeout(
    `${base}/chat/completions`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 256,
        stream: false,
      }),
    },
    VIDEO_API_TIMEOUT_MS,
  )
  if (!r2.ok) throw new Error(`AI video provider returned ${r2.status}: ${await readProviderError(r2)}`)
  const json = await r2.json().catch(() => ({}))
  const url = extractVideoUrl(json)
  if (url) return downloadVideo(url)
  throw new VideoNotSupportedError('The provider returned no video URL — its model may not support text-to-video.')
}

// Overlay a caption bar on an already-generated video with ffmpeg (text-to-video
// results don't bake in a caption, so we add it on top in a final pass).
async function overlayCaptionOnVideo(bytes, caption, outPath) {
  if (!(await hasFfmpeg())) throw new Error('ffmpeg is not installed — install it to add captions to generated videos.')
  const tmp = path.join(os.tmpdir(), `flixty-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp4`)
  await fs.promises.writeFile(tmp, bytes)
  let w = 1280, h = 720
  try {
    const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', tmp], { maxBuffer: 1024 * 1024 })
    const [ww, hh] = stdout.trim().split('x').map(Number)
    if (ww && hh) { w = ww; h = hh }
  } catch { /* fall back to the defaults */ }
  const capPath = path.join(os.tmpdir(), `flixty-${Date.now()}-${crypto.randomBytes(4).toString('hex')}-caption.png`)
  await fs.promises.writeFile(capPath, await renderCaptionPng(caption, w, h))
  try {
    await execFileP('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', tmp, '-i', capPath,
      '-filter_complex',
      '[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2[vb];[1:v]format=rgba[cap];[vb][cap]overlay=0:0:format=auto[vout]',
      '-map', '[vout]',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      outPath,
    ], { maxBuffer: 16 * 1024 * 1024 })
  } catch (e) {
    throw new Error(`ffmpeg failed while adding the caption: ${(e.stderr || e.message).slice(0, 500)}`)
  } finally {
    fs.promises.unlink(tmp).catch(() => {})
    fs.promises.unlink(capPath).catch(() => {})
  }
}
// ── Image-compose video generation (fallback) ────────────────────────────────
//
// A short clip is composed entirely on this server: a handful of AI images are
// generated from the prompt (using the user's existing image provider), then
// ffmpeg assembles them into an MP4 with a slow Ken Burns zoom/pan per scene,
// crossfade transitions, and an optional caption overlaid at the bottom. Used
// when the provider has no text-to-video model.

const VIDEO_PRESETS = {
  '9:16': { w: 1080, h: 1920, imgSize: '1024x1792' },
  '16:9': { w: 1920, h: 1080, imgSize: '1792x1024' },
  '1:1':  { w: 1080, h: 1080, imgSize: '1024x1024' },
}

// A short visual-direction suffix per scene so the composed video doesn't look
// like the same image repeated — the prompt is otherwise identical.
const SCENE_DIRECTIONS = [
  'wide establishing shot',
  'medium shot, closer detail',
  'close-up, dramatic angle',
  'aerial view, sweeping',
  'cinematic final shot',
]

const VIDEO_FPS = 30
const VIDEO_FADE = 0.5

function scenePrompts(prompt, count) {
  return Array.from({ length: count }, (_, i) =>
    `${prompt}, ${SCENE_DIRECTIONS[i % SCENE_DIRECTIONS.length]}`
  )
}

// Wrap a caption into lines that fit the frame width at the given font size.
function wrapCaption(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (next.length <= maxChars) line = next
    else { if (line) lines.push(line); line = word }
  }
  if (line) lines.push(line)
  return lines
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Render the caption to a full-frame transparent PNG via sharp, so the text is
// crisp and we don't depend on ffmpeg's drawtext filter (often not compiled in).
async function renderCaptionPng(caption, w, h) {
  const fontSize = Math.max(28, Math.round(w / 18))
  const lineHeight = Math.round(fontSize * 1.3)
  const lines = wrapCaption(caption, Math.max(12, Math.floor(w / (fontSize * 0.55))))
  const padY = 28
  const barH = lines.length * lineHeight + padY * 2
  const textTop = h - barH + padY + fontSize * 0.8

  const tspans = lines
    .map((line, i) => `<tspan x="${w / 2}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`)
    .join('')

  const svg =
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="0" y="${h - barH}" width="${w}" height="${barH}" fill="rgba(0,0,0,0.45)"/>` +
    `<text x="${w / 2}" y="${textTop}" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#ffffff" text-anchor="middle">${tspans}</text>` +
    `</svg>`
  const sharp = (await import('sharp')).default
  return sharp(Buffer.from(svg)).png().toBuffer()
}

async function hasFfmpeg() {
  try { await execFileP('ffmpeg', ['-version']); return true } catch { return false }
}

// ── Video generation dispatch ────────────────────────────────────────────────
// Generate a video for a prompt. Prefers a real text-to-video model when the
// configured AI model is video-capable; otherwise (or when the provider can't
// do text-to-video) falls back to composing AI images + ffmpeg.
// Returns { filename, url, mimeType }.
export async function generateVideo(cfg, { prompt, aspectRatio = '16:9', duration = 5, caption = '' }) {
  if (['openrouter', 'openai'].includes(cfg.provider) && isVideoModel(cfg.model)) {
    try {
      const bytes = await requestTextToVideo(cfg, { prompt, aspectRatio, duration })
      const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.mp4`
      const outPath = path.join(__dirname, '..', 'data', 'uploads', filename)
      if (caption) await overlayCaptionOnVideo(bytes, caption, outPath)
      else await fs.promises.writeFile(outPath, bytes)
      return { filename, url: `${process.env.BASE_URL}/uploads/${filename}`, mimeType: 'video/mp4' }
    } catch (e) {
      if (!(e instanceof VideoNotSupportedError)) throw e
      // No usable text-to-video path — fall through to the image-compose strategy.
    }
  }
  return generateVideoFromImages(cfg, { prompt, aspectRatio, duration, caption })
}

// Compose the scenes + optional caption into an MP4 in data/uploads (original
// image-based approach). Returns { filename, url, mimeType }.
async function generateVideoFromImages(cfg, { prompt, aspectRatio = '16:9', duration = 5, caption = '' }) {
  if (!(await hasFfmpeg())) {
    throw new Error('ffmpeg is not installed — install it to generate videos (e.g. brew install ffmpeg).')
  }
  const preset = VIDEO_PRESETS[aspectRatio] || VIDEO_PRESETS['16:9']
  const { w, h, imgSize } = preset

  const sceneCount = duration >= 10 ? 5 : 3
  // Total length = sceneCount*sceneDur - (sceneCount-1)*fade; solve for sceneDur
  // so the composed clip lands exactly on the requested duration.
  const sceneDur = (duration + (sceneCount - 1) * VIDEO_FADE) / sceneCount
  const totalDur = sceneCount * sceneDur - (sceneCount - 1) * VIDEO_FADE
  const sceneFrames = Math.round(sceneDur * VIDEO_FPS)

  const tmpDir = os.tmpdir()
  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const sceneFiles = []
  let captionFile = null

  try {
    // 1. Generate the scene images (each with a different visual direction)
    for (let i = 0; i < sceneCount; i++) {
      const bytes = await generateImage(cfg, {
        prompt: scenePrompts(prompt, sceneCount)[i],
        size: imgSize,
      })
      const file = path.join(tmpDir, `flixty-${stamp}-scene-${i}.png`)
      await fs.promises.writeFile(file, bytes)
      sceneFiles.push(file)
    }

    // 2. Optional caption overlay image
    if (caption) {
      captionFile = path.join(tmpDir, `flixty-${stamp}-caption.png`)
      await fs.promises.writeFile(captionFile, await renderCaptionPng(caption, w, h))
    }

    // 3. ffmpeg filter graph: per scene scale→crop→Ken Burns zoompan, then a
    //    crossfade chain, then (optionally) overlay the caption.
    const chains = []
    for (let i = 0; i < sceneCount; i++) {
      chains.push(
        `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},` +
        `zoompan=z='min(zoom+0.0012,1.12)':d=${sceneFrames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${VIDEO_FPS},format=yuv420p[v${i}]`
      )
    }
    let prev = 'v0'
    let offset = sceneDur - VIDEO_FADE
    for (let i = 1; i < sceneCount; i++) {
      const out = i === sceneCount - 1 ? 'vbody' : `v0${i}`
      chains.push(`[${prev}][v${i}]xfade=transition=fade:duration=${VIDEO_FADE}:offset=${offset.toFixed(3)}[${out}]`)
      offset += sceneDur - VIDEO_FADE
      prev = out
    }

    const args = ['-y', '-loglevel', 'error']
    for (const f of sceneFiles) args.push('-i', f)
    const captionIdx = sceneCount
    if (captionFile) {
      args.push('-loop', '1', '-framerate', String(VIDEO_FPS), '-t', totalDur.toFixed(3), '-i', captionFile)
    }

    if (captionFile) {
      chains.push(`[${captionIdx}:v]fps=${VIDEO_FPS},format=rgba[vcap];[vbody][vcap]overlay=0:0:format=auto[vout]`)
    }
    args.push('-filter_complex', chains.join(';'))
    args.push('-map', captionFile ? '[vout]' : '[vbody]')
    args.push(
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-r', String(VIDEO_FPS),
    )

    const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.mp4`
    const outPath = path.join(__dirname, '..', 'data', 'uploads', filename)
    args.push(outPath)

    try {
      await execFileP('ffmpeg', args, { maxBuffer: 16 * 1024 * 1024 })
    } catch (e) {
      throw new Error(`ffmpeg failed: ${(e.stderr || e.message).slice(0, 500)}`)
    }

    return {
      filename,
      url: `${process.env.BASE_URL}/uploads/${filename}`,
      mimeType: 'video/mp4',
    }
  } finally {
    // 4. Clean up temp images — never leave them behind
    for (const f of [...sceneFiles, captionFile].filter(Boolean)) {
      fs.promises.unlink(f).catch(() => {})
    }
  }
}
