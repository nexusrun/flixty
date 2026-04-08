import express from 'express'
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
import { requireAuth } from './lib/auth.js'
import { startScheduler } from './lib/scheduler.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000

// Ensure uploads dir exists
fs.mkdirSync(path.join(__dirname, 'data/uploads'), { recursive: true })

const app = express()

app.use(cors({
  origin: process.env.BASE_URL || 'http://localhost:3000',
  credentials: true
}))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))
app.use(session({
  secret: process.env.SESSION_SECRET || 'curator-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: (process.env.BASE_URL || '').startsWith('https'), sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 * 1000 } // 7-day session
}))

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')))

// Serve uploaded files publicly
app.use('/uploads', express.static(path.join(__dirname, 'data/uploads')))

// User auth routes — public (no requireAuth)
app.use('/api/user', userRoutes)

// Platform OAuth routes — callbacks are public (they come from OAuth providers),
// initiation and status require login
app.use('/auth', authRoutes)

// API routes — individual write endpoints enforce auth via requireAuth middleware
app.use('/api', postRoutes)
app.use('/api/ai', requireAuth, aiRoutes)
app.use('/api/live', requireAuth, liveRoutes)

app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }))

app.listen(PORT, () => {
  console.log(`\n🚀  Flixty backend → http://localhost:${PORT}`)
  console.log(`🔑  OAuth callbacks use BASE_URL=${process.env.BASE_URL || `http://localhost:${PORT}`}`)
  console.log(`📡  Connect platforms at /auth/{x,linkedin,facebook,youtube,tiktok}\n`)
})

startScheduler()
