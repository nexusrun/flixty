import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { fileURLToPath } from 'url'
import { savePost, getPosts, saveScheduled, getScheduled, removeScheduled, markPlatformPosted } from '../lib/store.js'
import { publishToPlatforms } from '../lib/publish.js'
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

  // If a file was uploaded, build a public URL (requires BASE_URL to be publicly accessible)
  const mediaUrl = req.file
    ? `${process.env.BASE_URL}/uploads/${req.file.filename}`
    : imageUrl || null
  const media = (req.file || mediaUrl)
    ? { url: mediaUrl, filePath: req.file?.path, mimeType: req.file?.mimetype }
    : null

  const { results, errors } = await publishToPlatforms(req.session.userId, {
    text, platforms, media, campaignName: req.body.campaignName,
  })

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
