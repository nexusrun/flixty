import cron from 'node-cron'
import * as twitter from '../platforms/twitter.js'
import * as linkedin from '../platforms/linkedin.js'
import * as facebook from '../platforms/facebook.js'
import * as instagram from '../platforms/instagram.js'
import * as youtube from '../platforms/youtube.js'
import * as tiktok from '../platforms/tiktok.js'
import { getTokens, saveToken, getScheduled, removeScheduled, savePost } from './store.js'

async function publishPost(post) {
  const tokens = getTokens()
  const results = {}, errors = {}

  await Promise.allSettled(post.platforms.map(async platform => {
    const tok = tokens[platform]
    if (!tok) { errors[platform] = 'Not connected'; return }
    try {
      if (platform === 'x')         results.x         = await twitter.postTweet(tok.access_token, post.text)
      if (platform === 'linkedin')  results.linkedin  = await linkedin.postUpdate(tok.access_token, tok.personId, post.text)
      if (platform === 'facebook')  results.facebook  = await facebook.postToPage(tok.pageToken, tok.pageId, post.text)
      if (platform === 'instagram') results.instagram = await instagram.post(tok.igAccountId, tok.pageToken, { imageUrl: post.imageUrl, caption: post.text })
      if (platform === 'tiktok') {
        if (!post.videoPath) { errors.tiktok = 'No video file attached to this scheduled post'; return }
        results.tiktok = await tiktok.uploadVideo(tok.access_token, post.videoPath, { caption: post.text })
      }
      if (platform === 'youtube') {
        if (!post.videoPath) { errors.youtube = 'No video file attached to this scheduled post'; return }
        const { access_token, refreshed, newTok } = await youtube.ensureFreshToken(tok)
        if (refreshed) saveToken('youtube', newTok)
        const title = (post.campaignName || post.text.split('\n')[0] || 'Untitled').slice(0, 100)
        results.youtube = await youtube.uploadVideo(access_token, post.videoPath, { title, description: post.text })
      }
    } catch (e) {
      errors[platform] = e.response?.data?.message || e.message
    }
  }))

  savePost({ ...post, results, errors, publishedAt: new Date().toISOString() })
  removeScheduled(post.id)
  console.log(`[scheduler] Published post ${post.id} →`, Object.keys(results).join(', ') || 'none (check errors)')
  return { results, errors }
}

export function startScheduler() {
  cron.schedule('* * * * *', async () => {
    const now = Date.now()
    const due = getScheduled().filter(p => new Date(p.scheduledAt).getTime() <= now)
    for (const post of due) await publishPost(post)
  })
  console.log('[scheduler] Running — checks every minute')
}

export { publishPost }
