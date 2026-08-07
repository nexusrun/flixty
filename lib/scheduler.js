import cron from 'node-cron'
import path from 'path'
import { getAllDueScheduled, removeScheduled, savePost } from './store.js'
import { publishToPlatforms } from './publish.js'

async function publishPost(post) {
  const userId = post.userId

  // Video file takes priority (YouTube / Facebook video), otherwise fall
  // back to a typed image URL (Instagram / Facebook photo) — same rule the
  // immediate-publish route uses, so scheduled and immediate posts behave
  // the same way.
  const media = post.videoPath
    ? { filePath: post.videoPath, mimeType: post.mimeType, url: `${process.env.BASE_URL}/uploads/${path.basename(post.videoPath)}` }
    : (post.imageUrl ? { url: post.imageUrl } : null)

  // scheduled_posts doesn't store the thumbnail's mime type separately —
  // guessed from the extension, defaulting to jpeg (the common case).
  const thumbnail = post.thumbnailPath
    ? { filePath: post.thumbnailPath, mimeType: post.thumbnailPath.endsWith('.png') ? 'image/png' : 'image/jpeg' }
    : null

  const { results, errors } = await publishToPlatforms(userId, {
    text: post.text, platforms: post.platforms, media, thumbnail, campaignName: post.campaignName,
  })

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
