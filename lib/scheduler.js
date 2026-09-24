import cron from 'node-cron'
import path from 'path'
import { claimDueScheduled, savePost } from './store.js'
import { publishToPlatforms } from './publish.js'

async function publishPost(post) {
  const userId = post.userId

  // Video file takes priority (YouTube / Facebook video), otherwise fall
  // back to a typed image URL (Instagram / Facebook photo) — same rule the
  // immediate-publish route uses, so scheduled and immediate posts behave
  // the same way.
  const mediaUrl = post.videoPath
    ? `${process.env.BASE_URL}/uploads/${path.basename(post.videoPath)}`
    : (post.imageUrl || null)
  const media = post.videoPath
    ? { filePath: post.videoPath, mimeType: post.mimeType, url: mediaUrl }
    : (post.imageUrl ? { url: post.imageUrl } : null)

  // scheduled_posts doesn't store the thumbnail's mime type separately —
  // guessed from the extension, defaulting to jpeg (the common case).
  const thumbnail = post.thumbnailPath
    ? { filePath: post.thumbnailPath, mimeType: post.thumbnailPath.endsWith('.png') ? 'image/png' : 'image/jpeg' }
    : null

  let results = {}, errors = {}
  try {
    ({ results, errors } = await publishToPlatforms(userId, {
      text: post.text, platforms: post.platforms, media, thumbnail, campaignName: post.campaignName, accountTargets: post.accountTargets,
    }))
  } catch (e) {
    // The post is already off the queue — record the failure on every
    // platform so it shows up in history instead of silently vanishing.
    for (const p of post.platforms) errors[p] = e.message
  }

  // Only the fields a post row actually carries — spreading the whole
  // scheduled row here used to store its id/userId/paths into posts.meta.
  await savePost(userId, {
    text: post.text,
    platforms: post.platforms,
    mediaUrl,
    campaignName: post.campaignName || undefined,
    scheduledAt: post.scheduledAt,
    results,
    errors,
    publishedAt: new Date().toISOString(),
  })
  console.log(`[scheduler] Published scheduled post ${post.id} (user ${userId}) →`, Object.keys(results).join(', ') || 'none (check errors)')
  return { results, errors }
}

let running = false

export function startScheduler() {
  cron.schedule('* * * * *', async () => {
    // A slow publish can outlast the one-minute tick; don't start a second
    // pass alongside it (claimDueScheduled already prevents double-publishing,
    // this just avoids piling up concurrent passes).
    if (running) return
    running = true
    try {
      const due = await claimDueScheduled()
      for (const post of due) {
        try {
          await publishPost(post)
        } catch (e) {
          console.error(`[scheduler] Failed to publish scheduled post ${post.id} (user ${post.userId}):`, e.message)
        }
      }
    } catch (e) {
      console.error('[scheduler] tick failed:', e.message)
    } finally {
      running = false
    }
  })
  console.log('[scheduler] Running — checks every minute')
}

export { publishPost }
