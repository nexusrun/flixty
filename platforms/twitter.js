import crypto from 'crypto'
import axios from 'axios'

const CLIENT_ID = process.env.X_CLIENT_ID
const CLIENT_SECRET = process.env.X_CLIENT_SECRET
const REDIRECT_URI = `${process.env.BASE_URL}/auth/x/callback`
const SCOPES = ['tweet.write', 'users.read', 'offline.access']

// In-memory PKCE state (fine for single-user local app)
const pkceStore = new Map()

export function getAuthUrl(state) {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  pkceStore.set(state, verifier)
  const p = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI, scope: SCOPES.join(' '),
    state, code_challenge: challenge, code_challenge_method: 'S256'
  })
  return `https://twitter.com/i/oauth2/authorize?${p}`
}

export async function exchangeCode(code, state) {
  const verifier = pkceStore.get(state)
  pkceStore.delete(state)
  const { data } = await axios.post(
    'https://api.twitter.com/2/oauth2/token',
    new URLSearchParams({ code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI, code_verifier: verifier }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, auth: { username: CLIENT_ID, password: CLIENT_SECRET } }
  )
  return data
}

export async function refreshAccessToken(token) {
  const { data } = await axios.post(
    'https://api.twitter.com/2/oauth2/token',
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, auth: { username: CLIENT_ID, password: CLIENT_SECRET } }
  )
  return data
}

export async function postTweet(accessToken, text) {
  const { data } = await axios.post(
    'https://api.twitter.com/2/tweets',
    { text },
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  )
  return data
}
