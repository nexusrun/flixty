import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { fileURLToPath } from 'url'
import * as linkedin from '../platforms/linkedin.js'
import * as facebook from '../platforms/facebook.js'
import * as instagram from '../platforms/instagram.js'
import * as youtube from '../platforms/youtube.js'
import { getTokens, saveToken, savePost, getPosts, saveScheduled, getScheduled, removeScheduled, markPlatformPosted } from '../lib/store.js'
import { buildXWebAction, buildTiktokWebAction } from '../lib/webPublish.js'
import { requireAuth } from '../lib/auth.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '../data/uploads'),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
  }),
  limits: { fileSize: 100 * 1024 * 1024 }
})

const router = Router()

router.post('/publish', requireAuth, upload.single('media'), async (req, res) => {
  const { text, imageUrl } = req.body
  const platforms = JSON.parse(req.body.platforms || '[]')
  const tokens = await getTokens(req.session.userId)
  const results = {}, errors = {}

  // If a file was uploaded, build a public URL (requires BASE_URL to be publicly accessible)
  const mediaUrl = req.file
    ? `${process.env.BASE_URL}/uploads/${req.file.filename}`
    : imageUrl || null

  // X and TikTok don't go through their APIs (X needs paid API access, TikTok
  // needs app review approval) — instead we hand back a link to the platform's
  // own web posting interface, pre-filled where possible, for the user to
  // finish manually. No token required for either.
  if (platforms.includes('x')) results.x = buildXWebAction(text)
  if (platforms.includes('tiktok')) results.tiktok = buildTiktokWebAction(text, mediaUrl)

  await Promise.allSettled(platforms.filter(p => p !== 'x' && p !== 'tiktok').map(async platform => {
    const tok = tokens[platform]
    if (!tok) { errors[platform] = 'Not connected — visit /auth/' + platform; return }
    try {
      if (platform === 'linkedin') results.linkedin = await linkedin.postUpdate(tok.access_token, tok.personId, text)
      if (platform === 'facebook') {
        const isVideo = req.file && req.file.mimetype.startsWith('video/')
        if (isVideo) {
          results.facebook = await facebook.postVideoToPage(tok.pageToken, tok.pageId, text, req.file.path)
        } else if (mediaUrl) {
          results.facebook = await facebook.postPhotoToPage(tok.pageToken, tok.pageId, text, mediaUrl)
        } else {
          results.facebook = await facebook.postToPage(tok.pageToken, tok.pageId, text)
        }
      }
      if (platform === 'instagram') {
        if (!mediaUrl) { errors.instagram = 'Instagram requires an image URL'; return }
        results.instagram = await instagram.post(tok.igAccountId, tok.pageToken, { imageUrl: mediaUrl, caption: text })
      }
      if (platform === 'youtube') {
        if (!req.file) { errors.youtube = 'YouTube requires a video file — attach one before publishing'; return }
        if (!req.file.mimetype.startsWith('video/')) { errors.youtube = `YouTube only supports video files — got ${req.file.mimetype}`; return }
        const { access_token, refreshed, newTok } = await youtube.ensureFreshToken(tok)
        if (refreshed) await saveToken(req.session.userId, 'youtube', newTok)
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

  const post = await savePost(req.session.userId, { text, platforms, mediaUrl, results, errors })
  res.json({ ok: Object.keys(results).length > 0, results, errors, post })
})

router.post('/schedule', requireAuth, upload.single('media'), async (req, res) => {
  const { text, scheduledAt, imageUrl, campaignName } = req.body
  const platforms = JSON.parse(req.body.platforms || '[]')
  if (!scheduledAt) return res.status(400).json({ error: 'scheduledAt required (ISO 8601)' })
  const videoPath  = req.file ? req.file.path     : null
  const mimeType   = req.file ? req.file.mimetype  : null
  const item = await saveScheduled(req.session.userId, { text, platforms, scheduledAt, imageUrl, campaignName, videoPath, mimeType })
  res.json({ ok: true, scheduled: item })
})

router.delete('/scheduled/:id', requireAuth, async (req, res) => {
  await removeScheduled(req.session.userId, Number(req.params.id))
  res.json({ ok: true })
})

router.get('/posts',     requireAuth, async (req, res) => res.json(await getPosts(req.session.userId)))
router.get('/scheduled', requireAuth, async (req, res) => res.json(await getScheduled(req.session.userId)))

// Confirms a manual web-posted platform (X/TikTok) is done — clears the "pending" flag.
router.patch('/posts/:id/mark-posted', requireAuth, async (req, res) => {
  const { platform } = req.body
  if (!platform) return res.status(400).json({ error: 'platform required' })
  const post = await markPlatformPosted(req.session.userId, Number(req.params.id), platform)
  if (!post) return res.status(404).json({ error: 'Post not found' })
  res.json({ ok: true, post })
})

export default router
