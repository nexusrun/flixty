import { Router } from 'express'
import * as youtube from '../platforms/youtube.js'
import * as facebook from '../platforms/facebook.js'
import { getTokens, saveToken, saveLive, getLives, updateLive } from '../lib/store.js'

const router = Router()

// POST /api/live/start  { platforms: ['youtube','facebook'], title, description }
router.post('/start', async (req, res) => {
  const { platforms = [], title = 'Live Stream', description = '' } = req.body
  const tokens = getTokens()
  const results = {}, errors = {}

  await Promise.allSettled(platforms.map(async platform => {
    try {
      if (platform === 'youtube') {
        const tok = tokens.youtube
        if (!tok) throw new Error('YouTube not connected')
        const { access_token, refreshed, newTok } = await youtube.ensureFreshToken(tok)
        if (refreshed) saveToken('youtube', newTok)

        const broadcast = await youtube.createLiveBroadcast(access_token, title)
        const stream    = await youtube.createLiveStream(access_token, title)
        await youtube.bindBroadcast(access_token, broadcast.id, stream.id)

        const ingestion = stream.cdn.ingestionInfo
        results.youtube = {
          broadcastId: broadcast.id,
          streamId:    stream.id,
          rtmpUrl:     ingestion.rtmpsIngestionAddress || ingestion.ingestionAddress,
          streamKey:   ingestion.streamName,
          watchUrl:    `https://studio.youtube.com/video/${broadcast.id}/livestreaming`,
        }
      }

      if (platform === 'facebook') {
        const tok = tokens.facebook
        if (!tok) throw new Error('Facebook not connected')
        const live = await facebook.createLiveVideo(tok.pageToken, tok.pageId, title, description)
        const url  = live.secure_stream_url || live.stream_url || ''
        // Facebook stream_url = rtmps://live-api-s.facebook.com:443/rtmp/STREAM_KEY
        const lastSlash = url.lastIndexOf('/')
        const streamKey = url.slice(lastSlash + 1)
        const rtmpUrl   = url.slice(0, lastSlash)
        results.facebook = {
          liveVideoId: live.id,
          rtmpUrl,
          streamKey,
          watchUrl: `https://www.facebook.com/video/${live.id}`,
        }
      }
    } catch (e) {
      errors[platform] = e.response?.data?.error?.message || e.message
    }
  }))

  const entry = saveLive({ title, description, platforms, results, errors })
  res.json({ ok: Object.keys(results).length > 0, results, errors, live: entry })
})

// POST /api/live/:id/end
router.post('/:id/end', async (req, res) => {
  const lives = getLives()
  const live  = lives.find(l => l.id === Number(req.params.id))
  if (!live) return res.status(404).json({ error: 'Live stream not found' })

  const tokens = getTokens()
  const results = {}, errors = {}

  if (live.results?.youtube) {
    try {
      const tok = tokens.youtube
      if (!tok) throw new Error('YouTube not connected')
      const { access_token, refreshed, newTok } = await youtube.ensureFreshToken(tok)
      if (refreshed) saveToken('youtube', newTok)
      await youtube.transitionBroadcast(access_token, live.results.youtube.broadcastId, 'complete')
      results.youtube = { ended: true }
    } catch (e) { errors.youtube = e.response?.data?.error?.message || e.message }
  }

  if (live.results?.facebook) {
    try {
      const tok = tokens.facebook
      if (!tok) throw new Error('Facebook not connected')
      await facebook.endLiveVideo(tok.pageToken, live.results.facebook.liveVideoId)
      results.facebook = { ended: true }
    } catch (e) { errors.facebook = e.response?.data?.error?.message || e.message }
  }

  updateLive(live.id, { endedAt: new Date().toISOString(), status: 'ended' })
  res.json({ ok: true, results, errors })
})

// GET /api/live/:id/status
router.get('/:id/status', async (req, res) => {
  const lives = getLives()
  const live  = lives.find(l => l.id === Number(req.params.id))
  if (!live) return res.status(404).json({ error: 'Not found' })

  const tokens = getTokens()
  const status = {}

  if (live.results?.youtube) {
    try {
      const tok = tokens.youtube
      const { access_token, refreshed, newTok } = await youtube.ensureFreshToken(tok)
      if (refreshed) saveToken('youtube', newTok)
      const b = await youtube.getBroadcastStatus(access_token, live.results.youtube.broadcastId)
      status.youtube = {
        lifecycleStatus: b?.status?.lifeCycleStatus || 'unknown',
        viewers: b?.statistics?.concurrentViewers || 0,
      }
    } catch (e) { status.youtube = { error: e.message } }
  }

  if (live.results?.facebook) {
    try {
      const tok = tokens.facebook
      const fb = await facebook.getLiveVideoStatus(tok.pageToken, live.results.facebook.liveVideoId)
      status.facebook = { status: fb.status, viewers: fb.live_views || 0 }
    } catch (e) { status.facebook = { error: e.message } }
  }

  res.json(status)
})

// GET /api/live
router.get('/', (_req, res) => res.json(getLives()))

export default router
