import axios from 'axios'

// Instagram's container-creation step has Meta's servers fetch imageUrl back
// from us before it returns — a real network round trip on top of our own
// request, with no way to know in advance how long it'll take. Neither call
// had a timeout, so a slow response just hung the request indefinitely;
// if that outlasted the reverse proxy's own upstream timeout, the client saw
// an opaque 502 with nothing useful logged on our side, while our process
// kept waiting on Meta regardless. Bounding it here means a slow/unresponsive
// Graph API fails with a clear error we control instead.
const GRAPH_TIMEOUT_MS = 20000

export async function post(igAccountId, pageToken, { imageUrl, caption }) {
  if (!imageUrl) throw new Error('Instagram requires a public image URL')
  // Step 1: create container
  const { data: container } = await axios.post(
    `https://graph.facebook.com/v19.0/${igAccountId}/media`,
    null,
    { params: { image_url: imageUrl, caption, access_token: pageToken }, timeout: GRAPH_TIMEOUT_MS }
  )
  // Step 2: publish
  const { data: result } = await axios.post(
    `https://graph.facebook.com/v19.0/${igAccountId}/media_publish`,
    null,
    { params: { creation_id: container.id, access_token: pageToken }, timeout: GRAPH_TIMEOUT_MS }
  )
  return result
}

// Impressions, reach, likes, comments, saves for a media object.
// Requires the instagram_manage_insights scope — throws if the connected
// token predates that scope, so callers can surface a "reconnect" prompt.
export async function getMediaMetrics(pageToken, mediaId) {
  const { data } = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}/insights`, {
    params: { metric: 'impressions,reach,likes,comments,saved', access_token: pageToken },
  })
  const values = {}
  for (const m of data.data || []) values[m.name] = m.values?.[0]?.value ?? 0
  return {
    likes: values.likes ?? 0,
    comments: values.comments ?? 0,
    shares: null,
    views: null,
    impressions: values.impressions ?? null,
    saves: values.saved ?? null,
    raw: values,
  }
}
