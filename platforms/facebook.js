import axios from 'axios'

const APP_ID = process.env.FB_APP_ID
const APP_SECRET = process.env.FB_APP_SECRET
const REDIRECT_URI = `${process.env.BASE_URL}/auth/facebook/callback`
const SCOPES = ['pages_manage_posts', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish']

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

export async function getPages(userToken) {
  const { data } = await axios.get('https://graph.facebook.com/v19.0/me/accounts', {
    params: { access_token: userToken }
  })
  return data.data // [{ id, name, access_token }]
}

export async function postToPage(pageToken, pageId, message) {
  const { data } = await axios.post(
    `https://graph.facebook.com/v19.0/${pageId}/feed`,
    null,
    { params: { message, access_token: pageToken } }
  )
  return data
}

export async function postPhotoToPage(pageToken, pageId, message, imageUrl) {
  const { data } = await axios.post(
    `https://graph.facebook.com/v19.0/${pageId}/photos`,
    null,
    { params: { message, url: imageUrl, access_token: pageToken } }
  )
  return data
}

export async function getInstagramAccountId(pageId, pageToken) {
  const { data } = await axios.get(`https://graph.facebook.com/v19.0/${pageId}`, {
    params: { fields: 'instagram_business_account', access_token: pageToken }
  })
  return data.instagram_business_account?.id || null
}
