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
import { startScheduler } from './lib/scheduler.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000

// Ensure uploads dir exists
fs.mkdirSync(path.join(__dirname, 'data/uploads'), { recursive: true })

const app = express()

app.use(cors({
  origin: true, // allow all origins (local HTML file uses origin: null)
  credentials: true
}))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))
app.use(session({
  secret: process.env.SESSION_SECRET || 'curator-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}))

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')))

// Serve uploaded files publicly
app.use('/uploads', express.static(path.join(__dirname, 'data/uploads')))

app.use('/auth', authRoutes)
app.use('/api', postRoutes)
app.use('/api/ai', aiRoutes)
app.use('/api/live', liveRoutes)

// index.html is served automatically by express.static above
app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }))

app.listen(PORT, () => {
  console.log(`\n🚀  Curator backend → http://localhost:${PORT}`)
  console.log(`🔑  OAuth callbacks use BASE_URL=${process.env.BASE_URL || `http://localhost:${PORT}`}`)
  console.log(`📡  Connect platforms:`)
  console.log(`    X:         http://localhost:${PORT}/auth/x`)
  console.log(`    LinkedIn:  http://localhost:${PORT}/auth/linkedin`)
  console.log(`    Facebook:  http://localhost:${PORT}/auth/facebook  (also connects Instagram)\n`)
})

startScheduler()
