import { Router } from 'express'
import crypto from 'crypto'
import axios from 'axios'
import { hashPassword, verifyPassword } from '../lib/auth.js'
import { findUserByEmail, findUserById, createUser } from '../lib/store.js'

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const googleRedirectUri = () => `${process.env.BASE_URL || 'http://localhost:3000'}/api/user/google/callback`

// Simple in-memory rate limiter — max 10 attempts per IP per 15 minutes
const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const rateLimitStore = new Map()

function rateLimiter(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const now = Date.now()
  const entry = rateLimitStore.get(ip)
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitStore.set(ip, { windowStart: now, count: 1 })
    return next()
  }
  entry.count++
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' })
  }
  next()
}

const router = Router()

// POST /api/user/register  { name, email, password }
router.post('/register', rateLimiter, async (req, res) => {
  const { name, email, password } = req.body
  if (!name || !email || !password)
    return res.status(400).json({ error: 'name, email and password are required' })
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' })
  if (findUserByEmail(email))
    return res.status(409).json({ error: 'An account with that email already exists' })

  const passwordHash = await hashPassword(password)
  const user = createUser({ name: name.trim(), email: email.trim().toLowerCase(), passwordHash })
  req.session.userId = user.id
  res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email } })
})

// POST /api/user/login  { email, password }
router.post('/login', rateLimiter, async (req, res) => {
  const { email, password } = req.body
  if (!email || !password)
    return res.status(400).json({ error: 'email and password are required' })

  const user = findUserByEmail(email)
  if (!user) return res.status(401).json({ error: 'Invalid email or password' })

  if (!user.passwordHash) return res.status(401).json({ error: 'This account uses Google Sign-In. Please sign in with Google.' })
  const ok = await verifyPassword(password, user.passwordHash)
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' })

  req.session.userId = user.id
  res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email } })
})

// POST /api/user/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }))
})

// GET /api/user/me
router.get('/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in', code: 'UNAUTHENTICATED' })
  const user = findUserById(req.session.userId)
  if (!user) return res.status(401).json({ error: 'Session invalid', code: 'UNAUTHENTICATED' })
  res.json({ id: user.id, name: user.name, email: user.email })
})

// GET /api/user/google  — initiate Google Sign-In
router.get('/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).send('<p>Google Sign-In is not configured on this server.</p>')
  const state = crypto.randomBytes(16).toString('hex')
  req.session.googleLoginState = state
  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  googleRedirectUri(),
    response_type: 'code',
    scope:         'openid email profile',
    state,
    access_type:   'online',
    prompt:        'select_account',
  })
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
})

// GET /api/user/google/callback  — Google redirects here after consent
router.get('/google/callback', async (req, res) => {
  const fail = msg => res.status(400).send(`<html><body><p style="font-family:sans-serif">Google Sign-In failed: ${msg}</p></body></html>`)
  if (!req.query.code) return fail('No authorization code received')
  if (req.query.state !== req.session.googleLoginState) return fail('State mismatch — please try again')

  try {
    // Exchange code for tokens
    const { data: tokens } = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code:          req.query.code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  googleRedirectUri(),
        grant_type:    'authorization_code',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    )

    // Get user profile
    const { data: profile } = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    })

    const email = profile.email?.toLowerCase()
    const name  = profile.name || profile.given_name || email

    // Find existing user or create one (Google users have no passwordHash)
    let user = findUserByEmail(email)
    if (!user) {
      user = createUser({ name, email, passwordHash: null, googleId: profile.sub })
    }

    req.session.userId = user.id

    // Close popup and notify the opener window
    res.send(`<html><body><script>
      window.opener && window.opener.postMessage('google-login-success', '*');
      window.close();
    </script><p>Signed in! You can close this window.</p></body></html>`)
  } catch (e) {
    fail(e.response?.data?.error_description || e.message)
  }
})

export default router
