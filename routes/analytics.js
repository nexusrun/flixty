import { Router } from 'express'
import { resolveAiConfig, completeAiText } from '../lib/ai.js'
import { getLatestSnapshotsSince, getTimeseriesSince, getLatestInsight, saveInsight } from '../lib/analytics/store.js'
import { getOverview, getTopPosts, getHashtagPerformance, sinceFor } from '../lib/analytics/queries.js'

const router = Router()

const engagementOf = r => (r.likes || 0) + (r.comments || 0) + (r.shares || 0)

// ── Overview ──

router.get('/overview', async (req, res) => {
  res.json(await getOverview(req.session.userId, req.query.range))
})

// ── Post leaderboard ──

router.get('/posts', async (req, res) => {
  res.json(await getTopPosts(req.session.userId, req.query.range, req.query.platform))
})

// ── Hashtag performance ──

router.get('/hashtags', async (req, res) => {
  res.json(await getHashtagPerformance(req.session.userId, req.query.range))
})

// ── Time series ──

router.get('/timeseries', async (req, res) => {
  const since = sinceFor(req.query.range)
  const metric = ['likes', 'comments', 'shares', 'views'].includes(req.query.metric) ? req.query.metric : 'likes'
  const rows = await getTimeseriesSince(req.session.userId, since.toISOString())

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

router.get('/insights', async (req, res) => {
  const insight = await getLatestInsight(req.session.userId)
  if (!insight) return res.json({ available: false, reason: 'No insights generated yet.' })
  res.json({
    available: true,
    summary: insight.summary,
    generatedAt: insight.generated_at,
    periodStart: insight.period_start,
    periodEnd: insight.period_end,
  })
})

router.post('/insights/refresh', async (req, res) => {
  const userId = req.session.userId
  const latest = await getLatestInsight(userId)
  if (latest && Date.now() - new Date(latest.generated_at).getTime() < REFRESH_COOLDOWN_MS) {
    return res.status(429).json({ error: 'Insights can be regenerated once per hour.' })
  }

  const since = sinceFor('30d')
  const snapshots = await getLatestSnapshotsSince(userId, since.toISOString())

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

  const format = list => list.map(p => `[${p.platform}] "${p.text}" — ${p.engagement} engagements (${p.likes || 0} likes, ${p.comments || 0} comments, ${p.shares || 0} shares)`).join('\n')

  const cfg = await resolveAiConfig(req.session.userId)
  const summary = (await completeAiText(cfg, {
    maxTokens: 400,
    messages: [{
      role: 'user',
      content: `Here are the top and bottom performing social posts from the last 30 days.

TOP PERFORMERS:
${format(top)}

BOTTOM PERFORMERS:
${format(bottom)}

Write 3-5 short, concrete, plain-English observations about what makes the top posts work better than the bottom ones (hooks, length, hashtags, platform, tone, structure). Each observation on its own line, no numbering, no preamble, no markdown.`,
    }],
  })).trim() || 'No insight generated.'
  const saved = await saveInsight(userId, { periodStart: since, periodEnd: new Date(), summary, raw: { top, bottom } })

  res.json({ available: true, summary: saved.summary, generatedAt: saved.generated_at, periodStart: saved.period_start, periodEnd: saved.period_end })
})

export default router
