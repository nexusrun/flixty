import { z } from 'zod'
import { savePost, getPosts, saveScheduled, getScheduled, removeScheduled } from '../store.js'
import { publishToPlatforms } from '../publish.js'
import { getOverview, getTopPosts, getHashtagPerformance } from '../analytics/queries.js'
import { downloadMedia, saveBase64Media } from './media.js'

// X still can't be posted through its API (needs paid access, see
// lib/webPublish.js) so it stays web-UI-only and isn't offered through MCP.
// TikTok posts through the real Content Posting API in sandbox mode
// (SELF_ONLY privacy) — see lib/publish.js.
const API_PLATFORMS = ['linkedin', 'facebook', 'instagram', 'youtube', 'tiktok']
const RANGE = z.enum(['7d', '30d', '90d']).default('7d')

const textResult = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
const errorResult = (message) => ({ content: [{ type: 'text', text: message }], isError: true })

const mediaFields = {
  imageUrl: z.string().url().optional().describe('Public URL of an image to attach (Facebook, Instagram)'),
  videoUrl: z.string().url().optional().describe('Public URL of a video to attach (YouTube, Facebook)'),
  videoData: z.string().optional().describe('Base64-encoded video content — use this instead of videoUrl when the file has no public URL (e.g. it only exists locally). Capped around 45MB.'),
  imageData: z.string().optional().describe('Base64-encoded image content — use this instead of imageUrl when the file has no public URL.'),
  mediaMimeType: z.string().optional().describe('MIME type of videoData/imageData, e.g. "video/mp4" or "image/png". Required when using videoData/imageData.'),
  thumbnailUrl: z.string().url().optional().describe('Public URL of a custom thumbnail image — YouTube only, requires a phone-verified channel.'),
  thumbnailData: z.string().optional().describe('Base64-encoded thumbnail image — use instead of thumbnailUrl when it has no public URL. YouTube only.'),
  thumbnailMimeType: z.string().optional().describe('MIME type of thumbnailData, e.g. "image/jpeg". Required when using thumbnailData.'),
}

// Priority: inline data over a URL, video over image — matches which
// platforms actually need which (YouTube needs a real file either way).
async function resolveMedia({ imageUrl, videoUrl, videoData, imageData, mediaMimeType }) {
  if (videoData) return saveBase64Media(videoData, mediaMimeType || 'video/mp4')
  if (videoUrl) return downloadMedia(videoUrl)
  if (imageData) return saveBase64Media(imageData, mediaMimeType || 'image/jpeg')
  if (imageUrl) return { url: imageUrl }
  return null
}

async function resolveThumbnail({ thumbnailUrl, thumbnailData, thumbnailMimeType }) {
  if (thumbnailData) return saveBase64Media(thumbnailData, thumbnailMimeType || 'image/jpeg')
  if (thumbnailUrl) return downloadMedia(thumbnailUrl)
  return null
}

export function registerTools(server, userId) {
  server.registerTool('create_post', {
    title: 'Create post',
    description: 'Publish a post immediately to one or more connected social platforms (LinkedIn, Facebook, Instagram, YouTube, TikTok). TikTok posts are sandbox-only (private, visible only to the connected TikTok account) until the app is approved for public posting. X is not supported here — it requires finishing manually on X\'s own site via the Flixty web app.',
    inputSchema: {
      text: z.string().min(1).describe('The post text/caption'),
      platforms: z.array(z.enum(API_PLATFORMS)).min(1).describe('Which platforms to publish to'),
      ...mediaFields,
      campaignName: z.string().optional().describe('Optional title, used as the YouTube video title'),
    },
  }, async ({ text, platforms, imageUrl, videoUrl, videoData, imageData, mediaMimeType, thumbnailUrl, thumbnailData, thumbnailMimeType, campaignName }) => {
    try {
      const media = await resolveMedia({ imageUrl, videoUrl, videoData, imageData, mediaMimeType })
      const thumbnail = await resolveThumbnail({ thumbnailUrl, thumbnailData, thumbnailMimeType })
      const { results, errors } = await publishToPlatforms(userId, { text, platforms, media, thumbnail, campaignName })
      // published_at gates the analytics collector — stamp it here just like
      // the immediate-publish route and the scheduler do.
      const post = await savePost(userId, { text, platforms, mediaUrl: media?.url || null, thumbnailUrl: thumbnail?.url || null, results, errors, publishedAt: new Date().toISOString() })
      return textResult({ post, results, errors })
    } catch (e) {
      return errorResult(`Failed to create post: ${e.message}`)
    }
  })

  server.registerTool('schedule_post', {
    title: 'Schedule post',
    description: 'Schedule a post to be published at a future time on one or more connected platforms (LinkedIn, Facebook, Instagram, YouTube, TikTok). TikTok posts are sandbox-only (private) until the app is approved for public posting.',
    inputSchema: {
      text: z.string().min(1),
      platforms: z.array(z.enum(API_PLATFORMS)).min(1),
      scheduledAt: z.string().describe('ISO 8601 date-time to publish at'),
      ...mediaFields,
      campaignName: z.string().optional(),
    },
  }, async ({ text, platforms, scheduledAt, imageUrl, videoUrl, videoData, imageData, mediaMimeType, thumbnailUrl, thumbnailData, thumbnailMimeType, campaignName }) => {
    const when = new Date(scheduledAt)
    if (Number.isNaN(when.getTime())) return errorResult('scheduledAt must be a valid ISO 8601 date-time')
    if (when.getTime() < Date.now() - 60 * 1000) return errorResult('scheduledAt is in the past — pick a future time')
    try {
      // A video is fetched/saved now so there's a local file ready when the
      // scheduler actually publishes; a plain image URL is just stored as-is
      // and resolved at publish time (same as the web app's scheduling flow).
      const media = await resolveMedia({ imageUrl, videoUrl, videoData, imageData, mediaMimeType })
      const thumbnail = await resolveThumbnail({ thumbnailUrl, thumbnailData, thumbnailMimeType })
      const item = await saveScheduled(userId, {
        text, platforms, scheduledAt, campaignName,
        imageUrl: media?.filePath ? null : (media?.url || null),
        videoPath: media?.filePath || null,
        mimeType: media?.filePath ? media.mimeType : null,
        thumbnailPath: thumbnail?.filePath || null,
      })
      return textResult({ scheduled: item })
    } catch (e) {
      return errorResult(`Failed to schedule post: ${e.message}`)
    }
  })

  server.registerTool('list_posts', {
    title: 'List posts',
    description: 'List recently published posts, most recent first.',
    inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
  }, async ({ limit }) => {
    const posts = await getPosts(userId)
    return textResult(posts.slice(0, limit))
  })

  server.registerTool('list_scheduled', {
    title: 'List scheduled posts',
    description: 'List upcoming scheduled posts.',
    inputSchema: {},
  }, async () => textResult(await getScheduled(userId)))

  server.registerTool('cancel_scheduled', {
    title: 'Cancel scheduled post',
    description: 'Cancel a scheduled post before it publishes.',
    inputSchema: { id: z.number().int() },
  }, async ({ id }) => {
    await removeScheduled(userId, id)
    return textResult({ ok: true, id })
  })

  server.registerTool('get_overview', {
    title: 'Get analytics overview',
    description: 'Get an engagement summary across all platforms for a time range: totals, per-platform breakdown, average engagement rate.',
    inputSchema: { range: RANGE },
  }, async ({ range }) => textResult(await getOverview(userId, range)))

  server.registerTool('get_top_posts', {
    title: 'Get top posts',
    description: 'Get a leaderboard of posts ranked by engagement (likes + comments + shares) for a time range.',
    inputSchema: { range: RANGE, platform: z.enum(API_PLATFORMS).optional() },
  }, async ({ range, platform }) => textResult(await getTopPosts(userId, range, platform)))

  server.registerTool('get_hashtag_performance', {
    title: 'Get hashtag performance',
    description: 'Get engagement stats grouped by hashtag for a time range — which hashtags correlate with better performance.',
    inputSchema: { range: RANGE },
  }, async ({ range }) => textResult(await getHashtagPerformance(userId, range)))
}
