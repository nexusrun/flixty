import express from 'express'
import './lib/asyncErrors.js'
import cors from 'cors'
import session from 'express-session'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import 'dotenv/config'
import authRoutes from './routes/auth.js'
import postRoutes from './routes/posts.js'
import aiRoutes from './routes/ai.js'
import liveRoutes from './routes/live.js'
import userRoutes from './routes/user.js'
import analyticsRoutes from './routes/analytics.js'
import oauthServerRoutes from './routes/oauthServer.js'
import mcpRoutes from './routes/mcp.js'
import { requireAuth } from './lib/auth.js'
import { startScheduler } from './lib/scheduler.js'
import { runMigrations } from './lib/db/migrate.js'
import { PgSessionStore } from './lib/db/sessionStore.js'
import { startMetricsCollector } from './lib/analytics/collector.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000

// Ensure uploads dir exists
fs.mkdirSync(path.join(__dirname, 'data/uploads'), { recursive: true })

// Without a real secret, session cookies are signed with a value published in
// this repo and anyone could forge a login cookie. Only allowed for local dev.
const isProduction = process.env.NODE_ENV === 'production' || (process.env.BASE_URL || '').startsWith('https')
if (!process.env.SESSION_SECRET && isProduction) {
  console.error('[startup] SESSION_SECRET is not set — refusing to start in production. Set it to a long random value.')
  process.exit(1)
}

const app = express()

// Trust the reverse proxy (Nexus AI / nginx) so req.secure reflects HTTPS
// and express-session sends Secure cookies correctly
app.set('trust proxy', 1)

app.use(cors({
  origin: process.env.BASE_URL || 'http://localhost:3000',
  credentials: true
}))
// /mcp gets its own higher body limit — inline base64 media in a tool call
// needs real headroom (base64 inflates ~33% over the raw file), and this has
// to be registered before the global json() below since body-parser skips
// re-parsing a request whose body it's already consumed.
app.use('/mcp', express.json({ limit: '65mb' }))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))
app.use(session({
  store: new PgSessionStore(),
  secret: process.env.SESSION_SECRET || 'curator-dev-secret',
  resave: false,
  saveUninitialized: false,
  // 'lax', not 'strict': every OAuth flow (platform connects + Google Sign-In)
  // ends in a cross-site redirect back to our callback, and a strict cookie
  // is withheld on that navigation — the callback would see no session and
  // fail with "Session expired" / "State mismatch". Lax still keeps the
  // cookie off cross-site POSTs, which is what protects against CSRF.
  cookie: { secure: (process.env.BASE_URL || '').startsWith('https'), sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 } // 7-day session
}))

// Cross-origin write protection. nexusai.run isn't on the Public Suffix
// List, so every *.nexusai.run app counts as "same-site" with this one and
// SameSite=Lax cookies are still sent on their POSTs — any other app hosted
// there could make logged-in requests on a visitor's behalf. Browsers always
// send Origin on POST/PUT/PATCH/DELETE, so a write is only accepted when it
// comes from this app's own origin. Requests without Origin (curl, server-to-
// server) fall back to Sec-Fetch-Site, which only browsers send.
// Exempt: endpoints called by other servers, not browsers — MCP (bearer-token
// auth, no cookies), the MCP OAuth token/registration endpoints, and
// Facebook's signed data-deletion callback.
const ORIGIN_CHECK_EXEMPT = new Set(['/mcp', '/oauth/token', '/oauth/register', '/auth/facebook/data-deletion'])
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
app.use((req, res, next) => {
  if (SAFE_METHODS.has(req.method) || ORIGIN_CHECK_EXEMPT.has(req.path)) return next()
  const origin = req.get('origin')
  if (origin) {
    // Compared against both BASE_URL and the host this request actually
    // reached, so a missing/stale BASE_URL can't lock the app out of itself.
    const allowed = new Set([`${req.protocol}://${req.get('host')}`])
    if (process.env.BASE_URL) allowed.add(new URL(process.env.BASE_URL).origin)
    if (allowed.has(origin)) return next()
  } else {
    const site = req.get('sec-fetch-site')
    if (!site || site === 'same-origin' || site === 'none') return next()
  }
  res.status(403).json({ error: 'Cross-origin request blocked' })
})

// Root: landing page for guests, app for authenticated users
app.get('/', (req, res) => {
  if (req.session?.userId) {
    res.sendFile(path.join(__dirname, 'public/index.html'))
  } else {
    res.sendFile(path.join(__dirname, 'public/landing.html'))
  }
})

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')))

// Serve uploaded files publicly
// nosniff is defense-in-depth on top of the media allowlist in lib/mcp/media.js
// (which is what actually stops an .html/.svg file from ever landing here) —
// it stops a browser from re-guessing a served file's type from its content.
app.use('/uploads', express.static(path.join(__dirname, 'data/uploads'), {
  setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff'),
}))

// User auth routes — public (no requireAuth)
app.use('/api/user', userRoutes)

// Platform OAuth routes — callbacks are public (they come from OAuth providers),
// initiation and status require login
app.use('/auth', authRoutes)

// API routes — individual write endpoints enforce auth via requireAuth middleware
app.use('/api', postRoutes)
app.use('/api/ai', requireAuth, aiRoutes)
app.use('/api/live', requireAuth, liveRoutes)
app.use('/api/analytics', requireAuth, analyticsRoutes)

// MCP: OAuth 2.1 authorization server (register/authorize/token, public by
// design — DCR and the consent screen handle their own auth) + the /mcp
// endpoint itself (bearer-token protected, see routes/mcp.js).
app.use(oauthServerRoutes)
app.use(mcpRoutes)

app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }))

// Last-resort error handler — async route errors reach here via
// lib/asyncErrors.js instead of crashing the process.
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || (err.name === 'MulterError' ? 400 : 500)
  if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}:`, err.stack || err.message)
  if (res.headersSent) return res.end()
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message })
})

// Background work (cron jobs, fire-and-forget promises) must never take the
// whole server down with it — log and keep serving.
process.on('unhandledRejection', err => {
  console.error('[unhandledRejection]', err?.stack || err)
})

// The database isn't always ready the instant this process starts — e.g. a
// freshly (re)provisioned companion Postgres can still be finishing its own
// startup/credential setup for a stretch after the app container is already
// running. Retrying with backoff in-process handles that transient window
// directly instead of crashing on the first attempt and hoping the
// platform's container-restart policy happens to retry at the right moment.
async function runMigrationsWithRetry() {
  const maxAttempts = 20
  const baseDelayMs = 2000
  const maxDelayMs = 30000

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await runMigrations()
      return
    } catch (e) {
      if (attempt === maxAttempts) throw e
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
      console.warn(`[startup] database not ready (attempt ${attempt}/${maxAttempts}): ${e.message} — retrying in ${delay / 1000}s`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

async function start() {
  await runMigrationsWithRetry()

  app.listen(PORT, () => {
    console.log(`\n🚀  Flixty backend → http://localhost:${PORT}`)
    console.log(`🔑  OAuth callbacks use BASE_URL=${process.env.BASE_URL || `http://localhost:${PORT}`}`)
    console.log(`📡  Connect platforms at /auth/{x,linkedin,facebook,youtube,tiktok}\n`)
  })

  startScheduler()
  startMetricsCollector()
}

start().catch(e => {
  console.error('[startup] fatal:', e.message)
  process.exit(1)
})
