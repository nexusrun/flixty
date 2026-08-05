import crypto from 'crypto'
import { query } from '../db/pool.js'

const AUTH_CODE_TTL_MS = 10 * 60 * 1000        // 10 minutes
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000     // 1 hour
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

const hash = token => crypto.createHash('sha256').update(token).digest('hex')
const randomToken = () => crypto.randomBytes(32).toString('base64url')

// ── Clients (dynamic client registration) ──

export async function createClient({ clientName, redirectUris }) {
  const clientId = crypto.randomBytes(16).toString('hex')
  await query(
    `INSERT INTO mcp_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)`,
    [clientId, clientName || null, redirectUris]
  )
  return { clientId, clientName, redirectUris }
}

export async function getClient(clientId) {
  const { rows } = await query('SELECT * FROM mcp_clients WHERE client_id = $1', [clientId])
  if (!rows[0]) return null
  return { clientId: rows[0].client_id, clientName: rows[0].client_name, redirectUris: rows[0].redirect_uris }
}

// ── Authorization codes ──

export async function createAuthCode({ clientId, userId, redirectUri, codeChallenge, codeChallengeMethod }) {
  const code = randomToken()
  await query(
    `INSERT INTO mcp_auth_codes (code, client_id, user_id, redirect_uri, code_challenge, code_challenge_method, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [code, clientId, userId, redirectUri, codeChallenge, codeChallengeMethod || 'S256', new Date(Date.now() + AUTH_CODE_TTL_MS)]
  )
  return code
}

// Single-use: deletes the row on read so it can't be replayed.
export async function consumeAuthCode(code) {
  const { rows } = await query('DELETE FROM mcp_auth_codes WHERE code = $1 RETURNING *', [code])
  const row = rows[0]
  if (!row) return null
  if (new Date(row.expires_at).getTime() < Date.now()) return null
  return {
    clientId: row.client_id,
    userId: row.user_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
  }
}

// ── Access / refresh tokens ──

export async function issueTokenPair({ clientId, userId }) {
  const accessToken = randomToken()
  const refreshToken = randomToken()

  await query(
    `INSERT INTO mcp_access_tokens (token_hash, client_id, user_id, expires_at) VALUES ($1, $2, $3, $4)`,
    [hash(accessToken), clientId, userId, new Date(Date.now() + ACCESS_TOKEN_TTL_MS)]
  )
  await query(
    `INSERT INTO mcp_refresh_tokens (token_hash, client_id, user_id, expires_at) VALUES ($1, $2, $3, $4)`,
    [hash(refreshToken), clientId, userId, new Date(Date.now() + REFRESH_TOKEN_TTL_MS)]
  )

  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_MS / 1000 }
}

export async function findAccessToken(token) {
  const { rows } = await query('SELECT * FROM mcp_access_tokens WHERE token_hash = $1', [hash(token)])
  const row = rows[0]
  if (!row) return null
  if (new Date(row.expires_at).getTime() < Date.now()) return null
  return { clientId: row.client_id, userId: row.user_id }
}

// Consumes the refresh token (deleted) and issues a fresh pair — rotation
// prevents a leaked refresh token from being reused indefinitely.
export async function rotateRefreshToken(token) {
  const { rows } = await query('DELETE FROM mcp_refresh_tokens WHERE token_hash = $1 RETURNING *', [hash(token)])
  const row = rows[0]
  if (!row) return null
  if (new Date(row.expires_at).getTime() < Date.now()) return null
  return issueTokenPair({ clientId: row.client_id, userId: row.user_id })
}
