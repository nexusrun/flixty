import axios from 'axios'
import fs from 'fs'
import FormData from 'form-data'
import path from 'path'

const UPLOADS_DIR = path.resolve('./data/uploads')
function safeUploadPath(filePath) {
  const resolved = path.resolve(filePath)
  if (!resolved.startsWith(UPLOADS_DIR + path.sep) && resolved !== UPLOADS_DIR) {
    throw new Error('Invalid file path: outside uploads directory')
  }
  return resolved
}

const APP_ID = process.env.FB_APP_ID
const APP_SECRET = process.env.FB_APP_SECRET
const REDIRECT_URI = `${process.env.BASE_URL}/auth/facebook/callback`
const SCOPES = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'instagram_content_publish', 'publish_video', 'instagram_manage_insights']

export function getAuthUrl(state) {
  const p = new URLSearchParams({
    client_id: APP_ID, redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(','), state, response_type: 'code'
  })
  return `https://www.facebook.com/v19.0/dialog/oauth?${p}`
}

export async function exchangeCode(code) {
  // Short-lived
  const { data: short } = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
    params: { client_id: APP_ID, client_secret: APP_SECRET, redirect_uri: REDIRECT_URI, code }
  })
  // Long-lived (60-day)
  const { data: long } = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
    params: { grant_type: 'fb_exchange_token', client_id: APP_ID, client_secret: APP_SECRET, fb_exchange_token: short.access_token }
  })
  return long
}

// The Facebook user's numeric ID — stored alongside the token so the
// data-deletion webhook (which has no session, only Facebook's own user_id)
// can look up which of our users to delete data for.
export async function getMe(userToken) {
  const { data } = await axios.get('https://graph.facebook.com/v19.0/me', {
    params: { access_token: userToken, fields: 'id' }
  })
  return data.id
}

export async function getPages(userToken) {
  const { data } = await axios.get('https://graph.facebook.com/v19.0/me/accounts', {
    params: { access_token: userToken, fields: 'id,name,access_token,tasks' }
  })
  console.log('[facebook] /me/accounts raw:', JSON.stringify(data))
  if (data.error) throw new Error(`Facebook API error: ${data.error.message} (code ${data.error.code})`)
  return data.data ?? []
}

export async function postToPage(pageToken, pageId, message) {
  console.log('[facebook] postToPage pageId=%s message=%s', pageId, message?.slice(0, 50))
  try {
    const { data } = await axios.post(
      `https://graph.facebook.com/v19.0/${pageId}/feed`,
      { message },
      { params: { access_token: pageToken } }
    )
    return data
  } catch (e) {
    console.error('[facebook] postToPage error:', JSON.stringify(e.response?.data))
    throw e
  }
}

export async function postPhotoToPage(pageToken, pageId, message, imageUrl) {
  console.log('[facebook] postPhotoToPage pageId=%s imageUrl=%s', pageId, imageUrl)
  try {
    const { data } = await axios.post(
      `https://graph.facebook.com/v19.0/${pageId}/photos`,
      { caption: message, url: imageUrl },
      { params: { access_token: pageToken } }
    )
    return data
  } catch (e) {
    console.error('[facebook] postPhotoToPage error:', JSON.stringify(e.response?.data))
    throw e
  }
}

export async function postVideoToPage(pageToken, pageId, message, filePath) {
  console.log('[facebook] postVideoToPage pageId=%s filePath=%s', pageId, filePath)
  filePath = safeUploadPath(filePath)
  try {
    const form = new FormData()
    form.append('access_token', pageToken)
    form.append('description', message)
    form.append('source', fs.createReadStream(filePath))
    const { data } = await axios.post(
      `https://graph.facebook.com/v19.0/${pageId}/videos`,
      form,
      { headers: form.getHeaders(), maxBodyLength: Infinity }
    )
    return data
  } catch (e) {
    console.error('[facebook] postVideoToPage error:', JSON.stringify(e.response?.data))
    throw e
  }
}

// Reactions, comments, shares, views and post_impressions for a Page post.
//
// The Graph API rejects the *whole* request if any one requested field doesn't
// apply to the node type — and a Page *video* object supports neither
// `reactions` nor `shares` (only regular feed posts do), while a feed post has
// no `views`. Bundling them means one inapplicable field kills the entire
// metrics read, which is exactly how Facebook video posts ended up with no
// analytics at all. So every field goes out as its own best-effort request and
// a miss just drops that one value.
export async function getPostMetrics(pageToken, postId) {
  const field = async (fields) => {
    try {
      const { data } = await axios.get(`https://graph.facebook.com/v19.0/${postId}`, {
        params: { fields, access_token: pageToken },
      })
      return data
    } catch {
      return {}
    }
  }

  const [reactions, comments, shares, likes, video] = await Promise.all([
    field('reactions.summary(true).limit(0)'), // feed posts
    field('comments.summary(true).limit(0)'),  // feed posts + videos
    field('shares'),                           // feed posts
    field('likes.summary(true).limit(0)'),     // videos (reactions stand-in)
    field('views'),                            // videos
  ])

  // Every single field request failing means the object/token is broken, not
  // that the post genuinely has zero engagement — throw so the collector logs
  // it and skips instead of recording a misleading all-zero snapshot.
  if ([reactions, comments, shares, likes, video].every(d => Object.keys(d).length === 0)) {
    throw new Error(`Facebook metrics unavailable for ${postId} (all field requests failed)`)
  }

  let impressions = null
  try {
    const { data: insights } = await axios.get(`https://graph.facebook.com/v19.0/${postId}/insights`, {
      params: { metric: 'post_impressions', access_token: pageToken },
    })
    impressions = insights.data?.[0]?.values?.[0]?.value ?? null
  } catch {
    // insights unavailable (e.g. scope not granted, or a video needs different metrics) — leave impressions null
  }

  return {
    likes: reactions.reactions?.summary?.total_count ?? likes.likes?.summary?.total_count ?? 0,
    comments: comments.comments?.summary?.total_count ?? 0,
    shares: shares.shares?.count ?? 0,
    views: video.views ?? null,
    impressions,
    saves: null,
    raw: { reactions, comments, shares, likes, video },
  }
}

export async function getInstagramAccountId(pageId, pageToken) {
  const { data } = await axios.get(`https://graph.facebook.com/v19.0/${pageId}`, {
    params: { fields: 'instagram_business_account', access_token: pageToken }
  })
  return data.instagram_business_account?.id || null
}

// ── Live Streaming ──

export async function createLiveVideo(pageToken, pageId, title, description) {
  const { data } = await axios.post(
    `https://graph.facebook.com/v19.0/${pageId}/live_videos`,
    { title, description: description || '', status: 'LIVE_NOW' },
    { params: { access_token: pageToken } }
  )
  return data // { id, stream_url, secure_stream_url }
}

export async function endLiveVideo(pageToken, liveVideoId) {
  const { data } = await axios.post(
    `https://graph.facebook.com/v19.0/${liveVideoId}`,
    { end_live_video: true },
    { params: { access_token: pageToken } }
  )
  return data
}

export async function getLiveVideoStatus(pageToken, liveVideoId) {
  const { data } = await axios.get(
    `https://graph.facebook.com/v19.0/${liveVideoId}`,
    { params: { fields: 'id,title,status,live_views', access_token: pageToken } }
  )
  return data
}
