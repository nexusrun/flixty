import axios from 'axios'
import { isRateLimitError } from './facebook.js'

// Instagram's container-creation step has Meta's servers fetch imageUrl back
// from us before it returns — a real network round trip on top of our own
// request, with no way to know in advance how long it'll take. Neither call
// had a timeout, so a slow response just hung the request indefinitely;
// if that outlasted the reverse proxy's own upstream timeout, the client saw
// an opaque 502 with nothing useful logged on our side, while our process
// kept waiting on Meta regardless. Bounding it here means a slow/unresponsive
// Graph API fails with a clear error we control instead.
const GRAPH_TIMEOUT_MS = 20000

// Reels transcode asynchronously — the container isn't publishable until Meta
// finishes. Meta's guidance is to poll status_code up to once a minute for no
// more than 5 minutes; we poll a bit more eagerly since short clips are
// usually ready in well under a minute. The immediate-publish HTTP request can
// outlast a reverse-proxy upstream timeout while this runs — the post still
// completes and is saved server-side, and scheduled posts (background cron)
// aren't affected at all.
const CONTAINER_POLL_INTERVAL_MS = 5000
const CONTAINER_POLL_MAX_MS = 5 * 60 * 1000

async function waitForContainer(containerId, pageToken) {
  const deadline = Date.now() + CONTAINER_POLL_MAX_MS
  while (Date.now() < deadline) {
    const { data } = await axios.get(`https://graph.facebook.com/v19.0/${containerId}`, {
      params: { fields: 'status_code,status', access_token: pageToken }, timeout: GRAPH_TIMEOUT_MS,
    })
    if (data.status_code === 'FINISHED') return
    if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED') {
      throw new Error(`Instagram media processing ${data.status_code}: ${data.status || 'unknown error'}`)
    }
    await new Promise(r => setTimeout(r, CONTAINER_POLL_INTERVAL_MS))
  }
  throw new Error('Instagram media container did not finish processing within 5 minutes')
}

// `media` is { url, mimeType } — a video (posted as a Reel) or an image.
// Both must be at a publicly reachable URL; Meta's servers fetch it back
// before the container step returns.
export async function post(igAccountId, pageToken, { media, caption }) {
  if (!media?.url) throw new Error('Instagram requires a public image or video URL')
  const isVideo = media.mimeType?.startsWith('video/') || /\.(mp4|mov)(\?|$)/i.test(media.url)

  // Step 1: create container
  const createParams = isVideo
    ? { media_type: 'REELS', video_url: media.url, caption, access_token: pageToken }
    : { image_url: media.url, caption, access_token: pageToken }
  const { data: container } = await axios.post(
    `https://graph.facebook.com/v19.0/${igAccountId}/media`,
    null,
    { params: createParams, timeout: GRAPH_TIMEOUT_MS }
  )

  // Step 2: Reels transcode async and aren't publishable until done; image
  // containers are ready immediately, so don't pay the poll cost for them.
  if (isVideo) await waitForContainer(container.id, pageToken)

  // Step 3: publish
  const { data: result } = await axios.post(
    `https://graph.facebook.com/v19.0/${igAccountId}/media_publish`,
    null,
    { params: { creation_id: container.id, access_token: pageToken }, timeout: GRAPH_TIMEOUT_MS }
  )
  return result
}

// Likes, comments, saves, reach, views for a media object. Requires the
// instagram_manage_insights scope.
//
// The insights endpoint is all-or-nothing per request: one metric that isn't
// valid for the media type (e.g. `impressions` is rejected for Reels and for
// anything created after mid-2024; `views` doesn't apply to older image
// posts) fails the whole call. So metrics go out in best-effort groups and
// are merged — the same approach as the Facebook collector. Throws only if
// every group fails (missing scope / stale token), so the collector logs it
// and the UI can prompt a reconnect instead of a silent all-zero snapshot.
export async function getMediaMetrics(pageToken, mediaId) {
  const fetchMetrics = async (metric) => {
    try {
      const { data } = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}/insights`, {
        params: { metric, access_token: pageToken }, timeout: GRAPH_TIMEOUT_MS,
      })
      const out = {}
      for (const m of data.data || []) out[m.name] = m.values?.[0]?.value ?? 0
      return out
    } catch (e) {
      if (isRateLimitError(e)) throw e
      return null
    }
  }

  const groups = await Promise.all([
    fetchMetrics('likes,comments,saved,reach'),
    fetchMetrics('views'),
    fetchMetrics('impressions'),
  ])

  if (groups.every(g => g === null)) {
    throw new Error(`Instagram insights unavailable for ${mediaId} (missing instagram_manage_insights scope or unsupported media)`)
  }

  const values = Object.assign({}, ...groups.filter(Boolean))
  return {
    likes: values.likes ?? 0,
    comments: values.comments ?? 0,
    shares: null,
    views: values.views ?? null,
    impressions: values.impressions ?? null,
    saves: values.saved ?? null,
    raw: values,
  }
}
