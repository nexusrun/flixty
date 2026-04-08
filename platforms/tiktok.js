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
const SCOPES        = ['user.info.basic', 'video.publish', 'video.upload']

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
  const chunkSize = Math.min(fileSize, 64 * 1024 * 1024) // max 64 MB per chunk

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
        total_chunk_count: Math.ceil(fileSize / chunkSize),
      },
    },
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' } }
  )

  const { upload_url, publish_id } = initRes.data?.data || {}
  if (!upload_url) throw new Error('TikTok did not return an upload_url — check app permissions')

  // Step 2 — upload the file in chunks
  const fileBuffer = fs.readFileSync(filePath)
  let offset = 0
  let chunkIndex = 0

  while (offset < fileSize) {
    const end   = Math.min(offset + chunkSize, fileSize)
    const chunk = fileBuffer.slice(offset, end)

    await axios.put(upload_url, chunk, {
      headers: {
        'Content-Type':  'video/mp4',
        'Content-Range': `bytes ${offset}-${end - 1}/${fileSize}`,
        'Content-Length': chunk.length,
      },
      maxBodyLength: Infinity,
    })

    offset = end
    chunkIndex++
  }

  return { publish_id }
}
