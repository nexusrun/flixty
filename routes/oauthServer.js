import { Router } from 'express'
import crypto from 'crypto'
import {
  createClient, getClient, createAuthCode, consumeAuthCode, issueTokenPair, rotateRefreshToken,
} from '../lib/mcpOAuth/store.js'
import { appBaseUrl } from '../lib/mcpOAuth/urls.js'

const router = Router()

const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

// ── Discovery metadata ──

router.get('/.well-known/oauth-authorization-server', (_req, res) => {
  const base = appBaseUrl()
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  })
})

router.get('/.well-known/oauth-protected-resource', (_req, res) => {
  res.json({
    resource: `${appBaseUrl()}/mcp`,
    authorization_servers: [appBaseUrl()],
  })
})

// ── Dynamic client registration (RFC 7591) — MCP clients like Claude Desktop
// register themselves on first connect. Public clients only (PKCE, no secret). ──

router.post('/oauth/register', async (req, res) => {
  const { client_name, redirect_uris } = req.body
  if (!Array.isArray(redirect_uris) || !redirect_uris.length) {
    return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' })
  }
  const client = await createClient({ clientName: client_name, redirectUris: redirect_uris })
  res.status(201).json({
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  })
})

// ── Authorize — consent screen backed by the existing session login ──

// The client name is self-chosen at registration, so on its own it proves
// nothing ("Flixty Official" could be anyone). The redirect destination is
// where the access grant actually goes — show it so the user can judge.
function redirectHost(uri) {
  try { return new URL(uri).host || uri } catch { return String(uri || '') }
}

function renderAuthorizePage({ loggedIn, clientName, redirectUri, query, error }) {
  const qs = new URLSearchParams(query).toString()
  return `<!doctype html><html><head><meta charset="utf-8"><title>Connect to Flixty</title>
  <style>
    body{font-family:-apple-system,sans-serif;background:#0b0f0e;color:#eaf5f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .card{background:#141b19;border:1px solid #263230;border-radius:16px;padding:32px;max-width:380px;width:90%}
    h1{font-size:18px;margin:0 0 8px}
    p{color:#9fb3ad;font-size:14px;line-height:1.5}
    input{width:100%;box-sizing:border-box;padding:10px 12px;margin:6px 0;border-radius:8px;border:1px solid #263230;background:#0b0f0e;color:#eaf5f0}
    button{width:100%;padding:10px 12px;border-radius:8px;border:none;font-weight:600;cursor:pointer;margin-top:10px}
    .approve{background:#00e5cc;color:#04211d}
    .deny{background:#263230;color:#eaf5f0}
    .err{color:#ff6b6b;font-size:13px;margin-top:8px}
  </style></head><body>
    <div class="card">
      ${loggedIn ? `
        <h1>Connect to Flixty</h1>
        <p><strong>${escHtml(clientName || 'An MCP client')}</strong> wants to access your Flixty account — create, view and schedule posts, and read your analytics.</p>
        <p>Approving sends access to <strong>${escHtml(redirectHost(redirectUri))}</strong>. The name above is chosen by the app itself — only approve if you recognize this destination and started this connection.</p>
        ${error ? `<p class="err">${escHtml(error)}</p>` : ''}
        <form method="POST" action="/oauth/authorize?${qs}">
          <button class="approve" name="decision" value="approve">Approve</button>
          <button class="deny" name="decision" value="deny">Deny</button>
        </form>
      ` : `
        <h1>Log in to Flixty</h1>
        <p>Log in to connect <strong>${escHtml(clientName || 'this MCP client')}</strong> to your account.</p>
        ${error ? `<p class="err">${escHtml(error)}</p>` : ''}
        <form id="login-form">
          <input type="email" id="email" placeholder="Email" required />
          <input type="password" id="password" placeholder="Password" required />
          <button class="approve" type="submit">Log in</button>
        </form>
        <p id="login-err" class="err"></p>
        <script>
          document.getElementById('login-form').addEventListener('submit', async function (e) {
            e.preventDefault()
            const res = await fetch('/api/user/login', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
              body: JSON.stringify({ email: document.getElementById('email').value, password: document.getElementById('password').value })
            })
            if (res.ok) { window.location.reload() }
            else { document.getElementById('login-err').textContent = (await res.json()).error || 'Login failed' }
          })
        </script>
      `}
    </div>
  </body></html>`
}

router.get('/oauth/authorize', async (req, res) => {
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state } = req.query

  if (response_type !== 'code') return res.status(400).send('Only response_type=code is supported')
  if (!code_challenge) return res.status(400).send('PKCE code_challenge is required')

  const client = await getClient(client_id)
  if (!client) return res.status(400).send('Unknown client_id')
  if (!client.redirectUris.includes(redirect_uri)) return res.status(400).send('redirect_uri does not match registered client')

  res.send(renderAuthorizePage({
    loggedIn: !!req.session.userId,
    clientName: client.clientName,
    redirectUri: redirect_uri,
    query: req.query,
  }))
})

router.post('/oauth/authorize', async (req, res) => {
  const { client_id, redirect_uri, code_challenge, code_challenge_method, state } = req.query
  const { decision } = req.body

  const client = await getClient(client_id)
  if (!client || !client.redirectUris.includes(redirect_uri)) return res.status(400).send('Invalid client or redirect_uri')

  if (!req.session.userId) {
    return res.send(renderAuthorizePage({ loggedIn: false, clientName: client.clientName, redirectUri: redirect_uri, query: req.query, error: 'Please log in first' }))
  }

  const redirectUrl = new URL(redirect_uri)
  if (decision !== 'approve') {
    redirectUrl.searchParams.set('error', 'access_denied')
    if (state) redirectUrl.searchParams.set('state', state)
    return res.redirect(redirectUrl.toString())
  }

  const code = await createAuthCode({
    clientId: client_id,
    userId: req.session.userId,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method || 'S256',
  })

  redirectUrl.searchParams.set('code', code)
  if (state) redirectUrl.searchParams.set('state', state)
  res.redirect(redirectUrl.toString())
})

// ── Token endpoint ──

function verifyPkce(verifier, challenge) {
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url')
  return computed === challenge
}

router.post('/oauth/token', async (req, res) => {
  const { grant_type } = req.body

  if (grant_type === 'authorization_code') {
    const { code, redirect_uri, client_id, code_verifier } = req.body
    if (!code || !code_verifier) return res.status(400).json({ error: 'invalid_request' })

    const entry = await consumeAuthCode(code)
    if (!entry) return res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired or already used' })
    if (entry.clientId !== client_id || entry.redirectUri !== redirect_uri) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id/redirect_uri mismatch' })
    }
    if (!verifyPkce(code_verifier, entry.codeChallenge)) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' })
    }

    const tokens = await issueTokenPair({ clientId: entry.clientId, userId: entry.userId })
    return res.json({
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
    })
  }

  if (grant_type === 'refresh_token') {
    const { refresh_token } = req.body
    if (!refresh_token) return res.status(400).json({ error: 'invalid_request' })

    const tokens = await rotateRefreshToken(refresh_token)
    if (!tokens) return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token expired or revoked' })

    return res.json({
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
    })
  }

  res.status(400).json({ error: 'unsupported_grant_type' })
})

export default router
