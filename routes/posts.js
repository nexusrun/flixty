import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { fileURLToPath } from 'url'
import * as twitter from '../platforms/twitter.js'
import * as linkedin from '../platforms/linkedin.js'
import * as facebook from '../platforms/facebook.js'
import * as instagram from '../platforms/instagram.js'
import * as youtube from '../platforms/youtube.js'
import * as tiktok from '../platforms/tiktok.js'
import { getTokens, saveToken, savePost, getPosts, saveScheduled, getScheduled, removeScheduled } from '../lib/store.js'
import { publishPost } from '../lib/scheduler.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '../data/uploads'),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
  }),
  limits: { fileSize: 100 * 1024 * 1024 }
})

const router = Router()

router.post('/publish', upload.single('media'), async (req, res) => {
  const { text, imageUrl } = req.body
  const platforms = JSON.parse(req.body.platforms || '[]')
  const tokens = getTokens()
  const results = {}, errors = {}

  // If a file was uploaded, build a public URL (requires BASE_URL to be publicly accessible)
  const mediaUrl = req.file
    ? `${process.env.BASE_URL}/uploads/${req.file.filename}`
    : imageUrl || null

  await Promise.allSettled(platforms.map(async platform => {
    const tok = tokens[platform]
    if (!tok) { errors[platform] = 'Not connected — visit /auth/' + platform; return }
    try {
      if (platform === 'x')        results.x        = await twitter.postTweet(tok.access_token, text)
      if (platform === 'linkedin') results.linkedin = await linkedin.postUpdate(tok.access_token, tok.personId, text)
      if (platform === 'facebook') {
        results.facebook = mediaUrl
          ? await facebook.postPhotoToPage(tok.pageToken, tok.pageId, text, mediaUrl)
          : await facebook.postToPage(tok.pageToken, tok.pageId, text)
      }
      if (platform === 'instagram') {
        if (!mediaUrl) { errors.instagram = 'Instagram requires an image URL'; return }
        results.instagram = await instagram.post(tok.igAccountId, tok.pageToken, { imageUrl: mediaUrl, caption: text })
      }
      if (platform === 'tiktok') {
        if (!req.file) { errors.tiktok = 'TikTok requires a video file — attach one before publishing'; return }
        results.tiktok = await tiktok.uploadVideo(tok.access_token, req.file.path, { caption: text })
      }
      if (platform === 'youtube') {
        if (!req.file) { errors.youtube = 'YouTube requires a video file — attach one before publishing'; return }
        if (!req.file.mimetype.startsWith('video/')) { errors.youtube = `YouTube only supports video files — got ${req.file.mimetype}`; return }
        const { access_token, refreshed, newTok } = await youtube.ensureFreshToken(tok)
        if (refreshed) saveToken('youtube', newTok)
        const title    = (req.body.campaignName || text.split('\n')[0] || 'Untitled').slice(0, 100)
        const mimeType = req.file.mimetype
        results.youtube = await youtube.uploadVideo(access_token, req.file.path, { title, description: text, mimeType })
      }
    } catch (e) {
      errors[platform] = e.response?.data?.error?.message
                      || e.response?.data?.detail
                      || e.response?.data?.message
                      || e.message
    }
  }))

  const post = savePost({ text, platforms, mediaUrl, results, errors })
  res.json({ ok: Object.keys(results).length > 0, results, errors, post })
})

router.post('/schedule', upload.single('media'), async (req, res) => {
  const { text, scheduledAt, imageUrl, campaignName } = req.body
  const platforms = JSON.parse(req.body.platforms || '[]')
  if (!scheduledAt) return res.status(400).json({ error: 'scheduledAt required (ISO 8601)' })
  const videoPath  = req.file ? req.file.path     : null
  const mimeType   = req.file ? req.file.mimetype  : null
  const item = saveScheduled({ text, platforms, scheduledAt, imageUrl, campaignName, videoPath, mimeType })
  res.json({ ok: true, scheduled: item })
})

router.delete('/scheduled/:id', (req, res) => {
  removeScheduled(Number(req.params.id))
  res.json({ ok: true })
})

router.get('/posts',     (_req, res) => res.json(getPosts()))
router.get('/scheduled', (_req, res) => res.json(getScheduled()))

export default router
