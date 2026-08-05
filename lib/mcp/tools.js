import { z } from 'zod'
import { savePost, getPosts, saveScheduled, getScheduled, removeScheduled } from '../store.js'
import { publishToPlatforms } from '../publish.js'
import { getOverview, getTopPosts, getHashtagPerformance } from '../analytics/queries.js'
import { downloadMedia } from './media.js'

// X and TikTok can't be posted through their APIs (see lib/webPublish.js) —
// they stay web-UI-only and aren't offered through MCP.
const API_PLATFORMS = ['linkedin', 'facebook', 'instagram', 'youtube']
const RANGE = z.enum(['7d', '30d', '90d']).default('7d')

const textResult = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
const errorResult = (message) => ({ content: [{ type: 'text', text: message }], isError: true })

async function resolveMedia({ imageUrl, videoUrl }) {
  if (videoUrl) return downloadMedia(videoUrl)
  if (imageUrl) return { url: imageUrl }
  return null
}

export function registerTools(server, userId) {
  server.registerTool('create_post', {
    title: 'Create post',
    description: 'Publish a post immediately to one or more connected social platforms (LinkedIn, Facebook, Instagram, YouTube). X and TikTok are not supported here — they require finishing manually on the platform\'s own site via the Flixty web app.',
    inputSchema: {
      text: z.string().min(1).describe('The post text/caption'),
      platforms: z.array(z.enum(API_PLATFORMS)).min(1).describe('Which platforms to publish to'),
      imageUrl: z.string().url().optional().describe('Public URL of an image to attach (Facebook, Instagram)'),
      videoUrl: z.string().url().optional().describe('Public URL of a video to attach (YouTube, Facebook)'),
      campaignName: z.string().optional().describe('Optional title, used as the YouTube video title'),
    },
  }, async ({ text, platforms, imageUrl, videoUrl, campaignName }) => {
    try {
      const media = await resolveMedia({ imageUrl, videoUrl })
      const { results, errors } = await publishToPlatforms(userId, { text, platforms, media, campaignName })
      const post = await savePost(userId, { text, platforms, mediaUrl: media?.url || null, results, errors })
      return textResult({ post, results, errors })
    } catch (e) {
      return errorResult(`Failed to create post: ${e.message}`)
    }
  })

  server.registerTool('schedule_post', {
    title: 'Schedule post',
    description: 'Schedule a post to be published at a future time on one or more connected platforms (LinkedIn, Facebook, Instagram, YouTube).',
    inputSchema: {
      text: z.string().min(1),
      platforms: z.array(z.enum(API_PLATFORMS)).min(1),
      scheduledAt: z.string().describe('ISO 8601 date-time to publish at'),
      imageUrl: z.string().url().optional(),
      campaignName: z.string().optional(),
    },
  }, async ({ text, platforms, scheduledAt, imageUrl, campaignName }) => {
    try {
      const item = await saveScheduled(userId, { text, platforms, scheduledAt, imageUrl, campaignName })
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
