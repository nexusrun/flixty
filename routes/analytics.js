import { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import { query } from '../lib/db/pool.js'
import {
  getLatestSnapshotsSince, getTimeseriesSince, getLatestInsight, saveInsight,
} from '../lib/analytics/store.js'

const router = Router()

const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 }
function sinceFor(range) {
  const days = RANGE_DAYS[range] || 7
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

const engagementOf = r => (r.likes || 0) + (r.comments || 0) + (r.shares || 0)

function extractHashtags(text) {
  return Array.from(new Set((text.match(/#\w+/g) || []).map(h => h.toLowerCase())))
}

// ── Overview ──

router.get('/overview', async (req, res) => {
  const since = sinceFor(req.query.range)

  const [{ rows: postCounts }, { rows: scheduledCounts }] = await Promise.all([
    query('SELECT count(*)::int AS n FROM posts WHERE published_at >= $1', [since]),
    query('SELECT count(*)::int AS n FROM scheduled_posts'),
  ])

  const snapshots = await getLatestSnapshotsSince(since.toISOString())

  const byPlatform = {}
  let totalEngagement = 0
  let engagementRateSum = 0, engagementRateCount = 0
  const postIds = new Set()
  const platformsUsed = new Set()
  const now = Date.now()
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000
  let thisWeek = 0
  const seenThisWeekPosts = new Set()

  for (const s of snapshots) {
    postIds.add(s.post_id)
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

  res.json({
    postsPublished: postCounts[0].n,
    scheduled: scheduledCounts[0].n,
    platformsUsed: platformsUsed.size,
    thisWeek,
    totalEngagement,
    avgEngagementRate: engagementRateCount ? Number((engagementRateSum / engagementRateCount).toFixed(4)) : null,
    platformBreakdown: Object.values(byPlatform).sort((a, b) => b.likes + b.comments + b.shares - (a.likes + a.comments + a.shares)),
  })
})

// ── Post leaderboard ──

router.get('/posts', async (req, res) => {
  const since = sinceFor(req.query.range)
  let snapshots = await getLatestSnapshotsSince(since.toISOString())

  if (req.query.platform) snapshots = snapshots.filter(s => s.platform === req.query.platform)

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
  res.json(list)
})

// ── Hashtag performance ──

router.get('/hashtags', async (req, res) => {
  const since = sinceFor(req.query.range)
  const snapshots = await getLatestSnapshotsSince(since.toISOString())

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
  res.json(list)
})

// ── Time series ──

router.get('/timeseries', async (req, res) => {
  const since = sinceFor(req.query.range)
  const metric = ['likes', 'comments', 'shares', 'views'].includes(req.query.metric) ? req.query.metric : 'likes'
  const rows = await getTimeseriesSince(since.toISOString())

  const byDay = {}
  for (const r of rows) {
    const day = r.captured_at.toISOString().slice(0, 10)
    byDay[day] = (byDay[day] || 0) + (r[metric] || 0)
  }

  const list = Object.entries(byDay).map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date))
  res.json(list)
})

// ── AI insights ──

const MIN_POSTS_FOR_INSIGHT = 10
const REFRESH_COOLDOWN_MS = 60 * 60 * 1000 // 1 hour

router.get('/insights', async (_req, res) => {
  const insight = await getLatestInsight()
  if (!insight) return res.json({ available: false, reason: 'No insights generated yet.' })
  res.json({
    available: true,
    summary: insight.summary,
    generatedAt: insight.generated_at,
    periodStart: insight.period_start,
    periodEnd: insight.period_end,
  })
})

router.post('/insights/refresh', async (_req, res) => {
  const latest = await getLatestInsight()
  if (latest && Date.now() - new Date(latest.generated_at).getTime() < REFRESH_COOLDOWN_MS) {
    return res.status(429).json({ error: 'Insights can be regenerated once per hour.' })
  }

  const since = sinceFor('30d')
  const snapshots = await getLatestSnapshotsSince(since.toISOString())

  const byPost = new Map()
  for (const s of snapshots) {
    const eng = engagementOf(s)
    const prev = byPost.get(s.post_id)
    if (!prev || eng > prev.engagement) byPost.set(s.post_id, { text: s.text, platform: s.platform, engagement: eng, likes: s.likes, comments: s.comments, shares: s.shares })
  }

  const posts = Array.from(byPost.values())
  if (posts.length < MIN_POSTS_FOR_INSIGHT) {
    return res.json({ available: false, reason: `Not enough data yet — need at least ${MIN_POSTS_FOR_INSIGHT} published posts with metrics (have ${posts.length}).` })
  }

  posts.sort((a, b) => b.engagement - a.engagement)
  const top = posts.slice(0, 5)
  const bottom = posts.slice(-5)

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set on this server.' })
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const format = list => list.map(p => `[${p.platform}] "${p.text}" — ${p.engagement} engagements (${p.likes || 0} likes, ${p.comments || 0} comments, ${p.shares || 0} shares)`).join('\n')

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: `Here are the top and bottom performing social posts from the last 30 days.

TOP PERFORMERS:
${format(top)}

BOTTOM PERFORMERS:
${format(bottom)}

Write 3-5 short, concrete, plain-English observations about what makes the top posts work better than the bottom ones (hooks, length, hashtags, platform, tone, structure). Each observation on its own line, no numbering, no preamble, no markdown.`,
    }],
  })

  const summary = response.content.find(b => b.type === 'text')?.text?.trim() || 'No insight generated.'
  const saved = await saveInsight({ periodStart: since, periodEnd: new Date(), summary, raw: { top, bottom } })

  res.json({ available: true, summary: saved.summary, generatedAt: saved.generated_at, periodStart: saved.period_start, periodEnd: saved.period_end })
})

export default router
