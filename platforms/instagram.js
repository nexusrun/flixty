import axios from 'axios'

export async function post(igAccountId, pageToken, { imageUrl, caption }) {
  if (!imageUrl) throw new Error('Instagram requires a public image URL')
  // Step 1: create container
  const { data: container } = await axios.post(
    `https://graph.facebook.com/v19.0/${igAccountId}/media`,
    null,
    { params: { image_url: imageUrl, caption, access_token: pageToken } }
  )
  // Step 2: publish
  const { data: result } = await axios.post(
    `https://graph.facebook.com/v19.0/${igAccountId}/media_publish`,
    null,
    { params: { creation_id: container.id, access_token: pageToken } }
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
