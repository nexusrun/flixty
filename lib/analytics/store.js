import { query } from '../db/pool.js'

const TRACKING_WINDOW_DAYS = 30

// Posts published within the tracking window, for discovering new (post, platform)
// pairs that don't have a post_metrics row yet.
export async function getPostsNeedingDiscovery() {
  const { rows } = await query(
    `SELECT id, user_id, platforms, results, published_at FROM posts
     WHERE published_at IS NOT NULL
       AND published_at >= now() - interval '${TRACKING_WINDOW_DAYS} days'`
  )
  return rows
}

export async function getTrackedPlatforms(postId) {
  const { rows } = await query('SELECT platform FROM post_metrics WHERE post_id = $1', [postId])
  return new Set(rows.map(r => r.platform))
}

export async function createPostMetric(postId, platform, externalId) {
  const { rows } = await query(
    `INSERT INTO post_metrics (post_id, platform, external_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (post_id, platform) DO UPDATE SET external_id = $3
     RETURNING *`,
    [postId, platform, externalId]
  )
  return rows[0]
}

// Active post_metrics rows due for a poll, per the cadence:
//   post < 48h old  → every 30 min
//   post 2-30d old  → daily
//   post > 30d old  → stop polling (caller deactivates)
export async function getDuePostMetrics() {
  const { rows } = await query(`
    SELECT pm.*, p.user_id, p.platforms, p.published_at
    FROM post_metrics pm
    JOIN posts p ON p.id = pm.post_id
    WHERE pm.polling_active = true
      AND (
        p.published_at >= now() - interval '48 hours'
          AND (pm.last_polled_at IS NULL OR pm.last_polled_at <= now() - interval '30 minutes')
        OR p.published_at < now() - interval '48 hours'
          AND p.published_at >= now() - interval '${TRACKING_WINDOW_DAYS} days'
          AND (pm.last_polled_at IS NULL OR pm.last_polled_at <= now() - interval '1 day')
      )
  `)
  return rows
}

export async function recordSnapshot(postMetricId, metrics) {
  const { likes = null, comments = null, shares = null, views = null, impressions = null, saves = null, raw = {} } = metrics
  const engagementRate = views ? Number((((likes || 0) + (comments || 0) + (shares || 0)) / views).toFixed(4)) : null

  await query(
    `INSERT INTO metric_snapshots
       (post_metric_id, likes, comments, shares, views, impressions, saves, engagement_rate, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [postMetricId, likes, comments, shares, views, impressions, saves, engagementRate, raw]
  )
  await query('UPDATE post_metrics SET last_polled_at = now() WHERE id = $1', [postMetricId])
}

export async function deactivatePolling(postMetricId) {
  await query('UPDATE post_metrics SET polling_active = false WHERE id = $1', [postMetricId])
}

// Latest snapshot per post_metric, joined with post + platform info — the
// building block for overview/leaderboard/hashtag queries.
export async function getLatestSnapshotsSince(userId, sinceISO) {
  const { rows } = await query(
    `SELECT DISTINCT ON (pm.id)
       p.id AS post_id, p.text, p.platforms AS post_platforms, p.published_at,
       pm.platform, pm.external_id,
       ms.likes, ms.comments, ms.shares, ms.views, ms.impressions, ms.saves,
       ms.engagement_rate, ms.captured_at
     FROM post_metrics pm
     JOIN posts p ON p.id = pm.post_id
     JOIN metric_snapshots ms ON ms.post_metric_id = pm.id
     WHERE p.user_id = $1 AND p.published_at >= $2
     ORDER BY pm.id, ms.captured_at DESC`,
    [userId, sinceISO]
  )
  return rows
}

export async function getTimeseriesSince(userId, sinceISO) {
  const { rows } = await query(
    `SELECT ms.captured_at, ms.likes, ms.comments, ms.shares, ms.views, pm.platform, p.id AS post_id
     FROM metric_snapshots ms
     JOIN post_metrics pm ON pm.id = ms.post_metric_id
     JOIN posts p ON p.id = pm.post_id
     WHERE p.user_id = $1 AND ms.captured_at >= $2
     ORDER BY ms.captured_at ASC`,
    [userId, sinceISO]
  )
  return rows
}

// ── AI insights cache ──

export async function getLatestInsight(userId) {
  const { rows } = await query('SELECT * FROM analytics_insights WHERE user_id = $1 ORDER BY generated_at DESC LIMIT 1', [userId])
  return rows[0] || null
}

export async function saveInsight(userId, { periodStart, periodEnd, summary, raw = {} }) {
  const { rows } = await query(
    `INSERT INTO analytics_insights (user_id, period_start, period_end, summary, raw)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, periodStart, periodEnd, summary, raw]
  )
  return rows[0]
}
