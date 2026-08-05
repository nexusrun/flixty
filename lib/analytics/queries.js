import { query } from '../db/pool.js'
import { getLatestSnapshotsSince } from './store.js'

// Shared by the analytics API routes and the MCP analytics tools.

export const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 }
export function sinceFor(range) {
  const days = RANGE_DAYS[range] || 7
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

const engagementOf = r => (r.likes || 0) + (r.comments || 0) + (r.shares || 0)

function extractHashtags(text) {
  return Array.from(new Set((text.match(/#\w+/g) || []).map(h => h.toLowerCase())))
}

export async function getOverview(userId, range) {
  const since = sinceFor(range)

  const [{ rows: postCounts }, { rows: scheduledCounts }] = await Promise.all([
    query('SELECT count(*)::int AS n FROM posts WHERE user_id = $1 AND published_at >= $2', [userId, since]),
    query('SELECT count(*)::int AS n FROM scheduled_posts WHERE user_id = $1', [userId]),
  ])

  const snapshots = await getLatestSnapshotsSince(userId, since.toISOString())

  const byPlatform = {}
  let totalEngagement = 0
  let engagementRateSum = 0, engagementRateCount = 0
  const platformsUsed = new Set()
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  let thisWeek = 0
  const seenThisWeekPosts = new Set()

  for (const s of snapshots) {
    platformsUsed.add(s.platform)
    const eng = engagementOf(s)
    totalEngagement += eng
    if (s.engagement_rate != null) { engagementRateSum += Number(s.engagement_rate); engagementRateCount++ }

    if (!byPlatform[s.platform]) byPlatform[s.platform] = { platform: s.platform, posts: 0, likes: 0, comments: 0, shares: 0, views: 0, impressions: 0 }
    const p = byPlatform[s.platform]
    p.posts++
    p.likes += s.likes || 0
    p.comments += s.comments || 0
    p.shares += s.shares || 0
    p.views += s.views || 0
    p.impressions += s.impressions || 0

    if (new Date(s.published_at).getTime() >= weekAgo && !seenThisWeekPosts.has(s.post_id)) {
      seenThisWeekPosts.add(s.post_id)
      thisWeek++
    }
  }

  return {
    postsPublished: postCounts[0].n,
    scheduled: scheduledCounts[0].n,
    platformsUsed: platformsUsed.size,
    thisWeek,
    totalEngagement,
    avgEngagementRate: engagementRateCount ? Number((engagementRateSum / engagementRateCount).toFixed(4)) : null,
    platformBreakdown: Object.values(byPlatform).sort((a, b) => (b.likes + b.comments + b.shares) - (a.likes + a.comments + a.shares)),
  }
}

export async function getTopPosts(userId, range, platform) {
  const since = sinceFor(range)
  let snapshots = await getLatestSnapshotsSince(userId, since.toISOString())
  if (platform) snapshots = snapshots.filter(s => s.platform === platform)

  const list = snapshots.map(s => ({
    postId: s.post_id,
    text: s.text,
    platform: s.platform,
    likes: s.likes || 0,
    comments: s.comments || 0,
    shares: s.shares || 0,
    views: s.views,
    impressions: s.impressions,
    engagementRate: s.engagement_rate,
    engagement: engagementOf(s),
    publishedAt: s.published_at,
    capturedAt: s.captured_at,
  }))

  list.sort((a, b) => b.engagement - a.engagement)
  return list
}

export async function getHashtagPerformance(userId, range) {
  const since = sinceFor(range)
  const snapshots = await getLatestSnapshotsSince(userId, since.toISOString())

  const byTag = {}
  for (const s of snapshots) {
    const eng = engagementOf(s)
    for (const tag of extractHashtags(s.text || '')) {
      if (!byTag[tag]) byTag[tag] = { hashtag: tag, uses: 0, totalEngagement: 0, bestPost: null }
      const t = byTag[tag]
      t.uses++
      t.totalEngagement += eng
      if (!t.bestPost || eng > t.bestPost.engagement) {
        t.bestPost = { postId: s.post_id, text: s.text, platform: s.platform, engagement: eng }
      }
    }
  }

  const list = Object.values(byTag).map(t => ({ ...t, avgEngagement: Number((t.totalEngagement / t.uses).toFixed(1)) }))
  list.sort((a, b) => b.avgEngagement - a.avgEngagement)
  return list
}
