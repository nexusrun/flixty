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

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const REDIRECT_URI  = `${process.env.BASE_URL}/auth/youtube/callback`
const SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
]

export function getAuthUrl(state) {
  const p = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         SCOPES.join(' '),
    access_type:   'offline',
    prompt:        'consent',
    state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`
}

export async function exchangeCode(code) {
  const { data } = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  )
  // Attach an absolute expiry timestamp so callers can check staleness
  data.expiry_date = Date.now() + (data.expires_in - 60) * 1000
  return data
}

export async function refreshAccessToken(refreshToken) {
  const { data } = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      refresh_token: refreshToken, client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET, grant_type: 'refresh_token',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  )
  data.expiry_date = Date.now() + (data.expires_in - 60) * 1000
  return data
}

// Returns a valid access token, refreshing if the stored one is expired or close to expiry.
// Pass the full stored token object; returns { access_token, refreshed, newTok? }
export async function ensureFreshToken(storedTok) {
  if (storedTok.expiry_date && Date.now() < storedTok.expiry_date) {
    return { access_token: storedTok.access_token, refreshed: false }
  }
  if (!storedTok.refresh_token) {
    throw new Error('YouTube access token expired and no refresh_token stored — reconnect YouTube')
  }
  const newTok = await refreshAccessToken(storedTok.refresh_token)
  return {
    access_token: newTok.access_token,
    refreshed:    true,
    newTok:       { ...storedTok, ...newTok },
  }
}

export async function getChannelTitle(accessToken) {
  const { data } = await axios.get(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  return data.items?.[0]?.snippet?.title || 'My Channel'
}

// Upload a video via resumable upload.
// mimeType should be the actual file MIME type (e.g. 'video/mp4').
export async function uploadVideo(accessToken, filePath, { title, description, tags = [], mimeType = 'video/mp4' }) {
  filePath = safeUploadPath(filePath)
  const stat = fs.statSync(filePath)

  // Step 1 — initiate resumable session and get the upload URL
  let initRes
  try {
    initRes = await axios.post(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        snippet: { title: title.slice(0, 100), description, tags },
        status:  { privacyStatus: 'public' },
      },
      {
        headers: {
          Authorization:             `Bearer ${accessToken}`,
          'Content-Type':            'application/json; charset=UTF-8',
          'X-Upload-Content-Type':   mimeType,
          'X-Upload-Content-Length': stat.size,
        },
      }
    )
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message
    throw new Error(`YouTube init failed: ${msg}`)
  }

  const uploadUrl = initRes.headers.location
  if (!uploadUrl) throw new Error('YouTube did not return an upload URL — check API quota and enabled APIs')

  // Step 2 — PUT the file to the upload URL
  let uploadData
  try {
    const { data } = await axios.put(uploadUrl, fs.createReadStream(filePath), {
      headers: {
        'Content-Type':   mimeType,
        'Content-Length': stat.size,
      },
      maxBodyLength:    Infinity,
      maxContentLength: Infinity,
    })
    uploadData = data
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message
    throw new Error(`YouTube upload failed: ${msg}`)
  }

  return uploadData
}

// ── Live Streaming ──
// Requires 'https://www.googleapis.com/auth/youtube' scope (broader than current upload-only scope).
// Users must reconnect YouTube after the scope update.

export async function createLiveBroadcast(accessToken, title) {
  const scheduledStartTime = new Date(Date.now() + 30000).toISOString()
  const { data } = await axios.post(
    'https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status,contentDetails',
    {
      snippet: { title: title.slice(0, 100), scheduledStartTime },
      status:  { privacyStatus: 'public', selfDeclaredMadeForKids: false },
      contentDetails: { enableAutoStart: true, enableAutoStop: true, enableClosedCaptions: false },
    },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  return data
}

export async function createLiveStream(accessToken, title) {
  const { data } = await axios.post(
    'https://www.googleapis.com/youtube/v3/liveStreams?part=snippet,cdn,status',
    {
      snippet: { title: title.slice(0, 100) },
      cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' },
    },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  return data
}

export async function bindBroadcast(accessToken, broadcastId, streamId) {
  const { data } = await axios.post(
    `https://www.googleapis.com/youtube/v3/liveBroadcasts/bind?id=${broadcastId}&part=id,contentDetails&streamId=${streamId}`,
    {},
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  return data
}

export async function transitionBroadcast(accessToken, broadcastId, broadcastStatus) {
  const { data } = await axios.post(
    `https://www.googleapis.com/youtube/v3/liveBroadcasts/transition?broadcastStatus=${broadcastStatus}&id=${broadcastId}&part=id,status`,
    {},
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  return data
}

export async function getBroadcastStatus(accessToken, broadcastId) {
  const { data } = await axios.get(
    `https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status,statistics&id=${broadcastId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  return data.items?.[0] || null
}
