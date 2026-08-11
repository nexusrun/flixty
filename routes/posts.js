import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { fileURLToPath } from 'url'
import { savePost, getPosts, saveScheduled, getScheduled, removeScheduled, updateScheduled, findDuplicateScheduled, markPlatformPosted } from '../lib/store.js'
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
// `media` is the primary attachment (image or video); `thumbnail` is a
// separate, optional cover image — currently only meaningful for YouTube,
// which has its own distinct thumbnail-upload API.
const uploadWithThumbnail = upload.fields([{ name: 'media', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }])

// ── Media resolution ──
//
// A client can attach media three ways, in priority order:
//   1. `media` — a multipart file upload (image or video)
//   2. `mediaFilename` — a server-side AI-generated file already saved in
//      data/uploads (currently AI videos); its path + public URL are rebuilt
//      here, exactly as if the file had just been uploaded
//   3. `imageUrl` — a remote image URL (Facebook photo / Instagram)
// `thumbnail` is always a separate optional image file upload.

// Never trust a client-supplied filename — it must be a bare name already
// inside data/uploads, not a path that could escape the directory.
function assertSafeUploadFilename(name) {
  if (typeof name !== 'string' || !name || name.startsWith('/') || name.includes('..') || path.basename(name) !== name) {
    throw new Error('Invalid media filename')
  }
}

function mimeTypeForFilename(filename) {
  if (filename.endsWith('.webm')) return 'video/webm'
  if (filename.endsWith('.mov')) return 'video/quicktime'
  return 'video/mp4'
}

function buildMedia(req) {
  const { imageUrl, mediaFilename } = req.body
  const mediaFile = req.files?.media?.[0]
  const thumbFile = req.files?.thumbnail?.[0]
  const uploadsDir = path.join(__dirname, '../data/uploads')

  let media = null, mediaUrl = null
  if (mediaFile) {
    mediaUrl = `${process.env.BASE_URL}/uploads/${mediaFile.filename}`
    media = { url: mediaUrl, filePath: mediaFile.path, mimeType: mediaFile.mimetype }
  } else if (mediaFilename) {
    assertSafeUploadFilename(mediaFilename)
    const filePath = path.join(uploadsDir, mediaFilename)
    mediaUrl = `${process.env.BASE_URL}/uploads/${mediaFilename}`
    media = { url: mediaUrl, filePath, mimeType: mimeTypeForFilename(mediaFilename) }
  } else if (imageUrl) {
    mediaUrl = imageUrl
    media = { url: imageUrl }
  }

  const thumbnailUrl = thumbFile ? `${process.env.BASE_URL}/uploads/${thumbFile.filename}` : null
  const thumbnail = thumbFile ? { filePath: thumbFile.path, mimeType: thumbFile.mimetype } : null
  return { media, mediaUrl, thumbnail, thumbnailUrl }
}

const router = Router()

router.post('/publish', requireAuth, uploadWithThumbnail, async (req, res) => {
  const { text } = req.body
  const platforms = JSON.parse(req.body.platforms || '[]')
  let accountTargets = {}
  try { accountTargets = JSON.parse(req.body.accountTargets || '{}') } catch { return res.status(400).json({ error: 'Invalid accountTargets' }) }

  let media, mediaUrl, thumbnail, thumbnailUrl
  try {
    ({ media, mediaUrl, thumbnail, thumbnailUrl } = buildMedia(req))
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }

  const { results, errors } = await publishToPlatforms(req.session.userId, {
    text, platforms, media, thumbnail, campaignName: req.body.campaignName, accountTargets,
  })

  const post = await savePost(req.session.userId, { text, platforms, mediaUrl, thumbnailUrl, results, errors })
  res.json({ ok: Object.keys(results).length > 0, results, errors, post })
})

router.post('/schedule', requireAuth, uploadWithThumbnail, async (req, res) => {
  const { text, scheduledAt, imageUrl, campaignName, mediaFilename } = req.body
  const platforms = JSON.parse(req.body.platforms || '[]')
  let accountTargets = {}
  try { accountTargets = JSON.parse(req.body.accountTargets || '{}') } catch { return res.status(400).json({ error: 'Invalid accountTargets' }) }
  if (!scheduledAt) return res.status(400).json({ error: 'scheduledAt required (ISO 8601)' })
  const mediaFile = req.files?.media?.[0]
  const thumbFile = req.files?.thumbnail?.[0]

  // Catches the classic double-click-the-schedule-button case — same text,
  // same instant, same platforms already pending. Scheduling the same
  // text/time to a *different* set of platforms is a legitimate separate
  // entry, not a duplicate, so it's still allowed.
  const dupeId = await findDuplicateScheduled(req.session.userId, { text, scheduledAt, platforms })
  if (dupeId) return res.status(409).json({ error: 'This exact post is already scheduled for that time on these platforms.', duplicateOf: dupeId })

  let videoPath = null, mimeType = null
  if (mediaFile) {
    videoPath = mediaFile.path
    mimeType = mediaFile.mimetype
  } else if (mediaFilename) {
    try { assertSafeUploadFilename(mediaFilename) } catch (e) { return res.status(400).json({ error: e.message }) }
    videoPath = path.join(__dirname, '../data/uploads', mediaFilename)
    mimeType = mimeTypeForFilename(mediaFilename)
  }
  const thumbnailPath = thumbFile ? thumbFile.path : null
  const item = await saveScheduled(req.session.userId, { text, platforms, accountTargets, scheduledAt, imageUrl, campaignName, videoPath, mimeType, thumbnailPath })
  res.json({ ok: true, scheduled: item })
})

router.put('/scheduled/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id)
  const { text, scheduledAt, imageUrl, campaignName, platforms, accountTargets = {} } = req.body
  if (!text || !scheduledAt || !Array.isArray(platforms) || !platforms.length) {
    return res.status(400).json({ error: 'text, scheduledAt and platforms are required' })
  }

  const dupeId = await findDuplicateScheduled(req.session.userId, { text, scheduledAt, platforms }, id)
  if (dupeId) return res.status(409).json({ error: 'This exact post is already scheduled for that time on these platforms.', duplicateOf: dupeId })

  const item = await updateScheduled(req.session.userId, id, { text, scheduledAt, imageUrl, campaignName, platforms, accountTargets })
  if (!item) return res.status(404).json({ error: 'Scheduled post not found' })
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
