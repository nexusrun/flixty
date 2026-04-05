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
