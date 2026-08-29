-- Immediate "Publish now" posts (the UI /publish route and the create_post MCP
-- tool) never stamped published_at — only the scheduler did. The analytics
-- collector's entire pipeline is gated on published_at IS NOT NULL (see
-- lib/analytics/store.js), so every non-scheduled post has been invisible to
-- analytics: never discovered, never polled, never counted.
--
-- The code paths now stamp published_at on save. This backfills the rows
-- created before that fix, using created_at as the timestamp — for an
-- immediate post that's within a second of when it actually went out.
--
-- The 30-day discovery window in getPostsNeedingDiscovery() still applies, so
-- only posts published within the last 30 days will start collecting metrics;
-- older ones just become visible in the historical dashboard totals.

UPDATE posts
SET published_at = created_at
WHERE published_at IS NULL;
