import cron from 'node-cron'
import path from 'path'
import * as linkedin from '../platforms/linkedin.js'
import * as facebook from '../platforms/facebook.js'
import * as instagram from '../platforms/instagram.js'
import * as youtube from '../platforms/youtube.js'
import { getTokens, saveToken, getAllDueScheduled, removeScheduled, savePost } from './store.js'
import { buildXWebAction, buildTiktokWebAction } from './webPublish.js'

async function publishPost(post) {
  const userId = post.userId
  const tokens = await getTokens(userId)
  const results = {}, errors = {}

  // X and TikTok can't auto-publish (no API access) — when their scheduled
  // time arrives, this post shows up as a "finish posting" reminder instead
  // (results[platform].pending, surfaced in Recent Posts) rather than
  // silently posting.
  if (post.platforms.includes('x')) results.x = buildXWebAction(post.text)
  if (post.platforms.includes('tiktok')) {
    const videoUrl = post.videoPath ? `${process.env.BASE_URL}/uploads/${path.basename(post.videoPath)}` : null
    results.tiktok = buildTiktokWebAction(post.text, videoUrl)
  }

  await Promise.allSettled(post.platforms.filter(p => p !== 'x' && p !== 'tiktok').map(async platform => {
    const tok = tokens[platform]
    if (!tok) { errors[platform] = 'Not connected'; return }
    try {
      if (platform === 'linkedin')  results.linkedin  = await linkedin.postUpdate(tok.access_token, tok.personId, post.text)
      if (platform === 'facebook')  results.facebook  = await facebook.postToPage(tok.pageToken, tok.pageId, post.text)
      if (platform === 'instagram') results.instagram = await instagram.post(tok.igAccountId, tok.pageToken, { imageUrl: post.imageUrl, caption: post.text })
      if (platform === 'youtube') {
        if (!post.videoPath) { errors.youtube = 'No video file attached to this scheduled post'; return }
        if (post.mimeType && !post.mimeType.startsWith('video/')) { errors.youtube = `YouTube only supports video files — got ${post.mimeType}`; return }
        const { access_token, refreshed, newTok } = await youtube.ensureFreshToken(tok)
        if (refreshed) await saveToken(userId, 'youtube', newTok)
        const title    = (post.campaignName || post.text.split('\n')[0] || 'Untitled').slice(0, 100)
        const mimeType = post.mimeType || 'video/mp4'
        results.youtube = await youtube.uploadVideo(access_token, post.videoPath, { title, description: post.text, mimeType })
      }
    } catch (e) {
      errors[platform] = e.response?.data?.message || e.message
    }
  }))

  await savePost(userId, { ...post, results, errors, publishedAt: new Date().toISOString() })
  await removeScheduled(userId, post.id)
  console.log(`[scheduler] Published post ${post.id} (user ${userId}) →`, Object.keys(results).join(', ') || 'none (check errors)')
  return { results, errors }
}

export function startScheduler() {
  cron.schedule('* * * * *', async () => {
    const due = await getAllDueScheduled()
    for (const post of due) await publishPost(post)
  })
  console.log('[scheduler] Running — checks every minute')
}

export { publishPost }
