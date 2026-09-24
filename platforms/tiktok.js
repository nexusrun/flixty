import crypto from 'crypto'
import axios from 'axios'
import fs from 'fs'
import path from 'path'

const UPLOADS_DIR = path.resolve('./data/uploads')
function safeUploadPath(filePath) {
  const resolved = path.resolve(filePath)
  if (!resolved.startsWith(UPLOADS_DIR + path.sep) && resolved !== UPLOADS_DIR) {
    throw new Error('Invalid file path: outside uploads directory')
  }
  return resolved
}

const CLIENT_KEY    = process.env.TIKTOK_CLIENT_KEY
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET
const REDIRECT_URI  = `${process.env.BASE_URL}/auth/tiktok/callback`
// Posting goes through TikTok's real Content Posting API in sandbox mode —
// SELF_ONLY privacy (private, visible only to the developer's own
// pre-added sandbox test account) is allowed without full app review, which
// is what these scopes are for. If the OAuth app isn't actually registered
// with sandbox access for these scopes, TikTok will reject the whole
// authorization request before the consent screen — that's a Developer
// Portal configuration issue, not something fixable from this code.
const SCOPES        = ['user.info.basic', 'video.publish', 'video.upload', 'video.list']

// In-memory PKCE store (single-user local app)
const pkceStore = new Map()

export function getAuthUrl(state) {
  const verifier  = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  pkceStore.set(state, verifier)

  const p = new URLSearchParams({
    client_key:            CLIENT_KEY,
    scope:                 SCOPES.join(','),
    response_type:         'code',
    redirect_uri:          REDIRECT_URI,
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  })
  return `https://www.tiktok.com/v2/auth/authorize/?${p}`
}

export async function exchangeCode(code, state) {
  const verifier = pkceStore.get(state)
  pkceStore.delete(state)

  const { data } = await axios.post(
    'https://open.tiktokapis.com/v2/oauth/token/',
    new URLSearchParams({
      client_key:    CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      code,
      grant_type:    'authorization_code',
      redirect_uri:  REDIRECT_URI,
      code_verifier: verifier,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  )
  if (data.expires_in) data.expiry_date = Date.now() + data.expires_in * 1000
  return data
}

export async function refreshAccessToken(refreshToken) {
  const { data } = await axios.post(
    'https://open.tiktokapis.com/v2/oauth/token/',
    new URLSearchParams({
      client_key:    CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  )
  return data
}

// TikTok access tokens only live 24 hours (the refresh token lasts a year), so
// every API call goes through this. Pass the full stored token object (as
// returned by getTokens, which adds savedAt); returns
// { access_token, refreshed, newTok? } — same contract as youtube.ensureFreshToken.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000
export async function ensureFreshToken(storedTok) {
  // Tokens saved before expiry_date was recorded: derive it from when the
  // token row was written plus TikTok's expires_in.
  const expiresAt = storedTok.expiry_date
    || (storedTok.savedAt && storedTok.expires_in ? storedTok.savedAt + storedTok.expires_in * 1000 : 0)
  if (expiresAt && Date.now() < expiresAt - EXPIRY_MARGIN_MS) {
    return { access_token: storedTok.access_token, refreshed: false }
  }
  if (!storedTok.refresh_token) {
    throw new Error('TikTok access token expired and no refresh_token stored — reconnect TikTok')
  }
  const fresh = await refreshAccessToken(storedTok.refresh_token)
  if (!fresh.access_token) {
    throw new Error(`TikTok token refresh failed: ${fresh.error_description || fresh.error || 'unknown error'} — reconnect TikTok`)
  }
  fresh.expiry_date = Date.now() + (fresh.expires_in || 86400) * 1000
  return { access_token: fresh.access_token, refreshed: true, newTok: { ...storedTok, ...fresh } }
}

export async function getUserInfo(accessToken) {
  const { data } = await axios.get(
    'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  return data?.data?.user || {}
}

// Upload a video to TikTok using the Direct Post (file upload) flow.
// privacyLevel: 'SELF_ONLY' works in sandbox; 'PUBLIC_TO_EVERYONE' requires TikTok production approval.
export async function uploadVideo(accessToken, filePath, { caption = '', privacyLevel = 'SELF_ONLY', disableDuet = false, disableComment = false, disableStitch = false } = {}) {
  filePath = safeUploadPath(filePath)
  const stat      = fs.statSync(filePath)
  const fileSize  = stat.size
  // TikTok's chunk rules: a file up to 64MB goes up as a single chunk;
  // larger files use 5–64MB chunks, total_chunk_count = floor(size / chunk),
  // and the last chunk absorbs the remainder (it may be up to 128MB). Using
  // ceil() here produced a too-small trailing chunk that TikTok rejects.
  const MAX_SINGLE_CHUNK = 64 * 1024 * 1024
  const chunkSize  = fileSize <= MAX_SINGLE_CHUNK ? fileSize : 10 * 1024 * 1024
  const chunkCount = fileSize <= MAX_SINGLE_CHUNK ? 1 : Math.floor(fileSize / chunkSize)

  // Step 1 — initialise the upload
  const initRes = await axios.post(
    'https://open.tiktokapis.com/v2/post/publish/video/init/',
    {
      post_info: {
        title:             caption.slice(0, 2200),
        privacy_level:     privacyLevel,
        disable_duet:      disableDuet,
        disable_comment:   disableComment,
        disable_stitch:    disableStitch,
      },
      source_info: {
        source:     'FILE_UPLOAD',
        video_size: fileSize,
        chunk_size: chunkSize,
        total_chunk_count: chunkCount,
      },
    },
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' } }
  )

  const { upload_url, publish_id } = initRes.data?.data || {}
  if (!upload_url) throw new Error('TikTok did not return an upload_url — check app permissions')

  // Step 2 — upload the file in chunks, reading one chunk at a time rather
  // than holding the whole video in memory
  const fh = await fs.promises.open(filePath, 'r')
  try {
    for (let i = 0; i < chunkCount; i++) {
      const start = i * chunkSize
      const end   = i === chunkCount - 1 ? fileSize : start + chunkSize
      const chunk = Buffer.alloc(end - start)
      await fh.read(chunk, 0, chunk.length, start)

      await axios.put(upload_url, chunk, {
        headers: {
          'Content-Type':  'video/mp4',
          'Content-Range': `bytes ${start}-${end - 1}/${fileSize}`,
          'Content-Length': chunk.length,
        },
        maxBodyLength: Infinity,
      })
    }
  } finally {
    await fh.close()
  }

  return { publish_id }
}

// Direct Post uploads return a publish_id, not the final video ID — this resolves
// the real video ID once TikTok finishes processing (may take a few minutes).
// Returns null while still processing.
export async function resolvePublishedVideoId(accessToken, publishId) {
  const { data } = await axios.post(
    'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
    { publish_id: publishId },
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' } }
  )
  const status = data?.data
  if (status?.status !== 'PUBLISH_COMPLETE') return null
  return status.publicaly_available_post_id?.[0] || status.publicly_available_post_id?.[0] || null
}

// Likes, comments, shares, views for a published video
export async function getVideoMetrics(accessToken, videoId) {
  const { data } = await axios.post(
    'https://open.tiktokapis.com/v2/video/query/?fields=id,like_count,comment_count,share_count,view_count',
    { filters: { video_ids: [videoId] } },
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' } }
  )
  const v = data?.data?.videos?.[0] || {}
  return {
    likes: v.like_count ?? 0,
    comments: v.comment_count ?? 0,
    shares: v.share_count ?? 0,
    views: v.view_count ?? 0,
    impressions: null,
    saves: null,
    raw: v,
  }
}
