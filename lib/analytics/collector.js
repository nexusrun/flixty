import cron from 'node-cron'
import * as twitter from '../../platforms/twitter.js'
import * as youtube from '../../platforms/youtube.js'
import * as facebook from '../../platforms/facebook.js'
import * as instagram from '../../platforms/instagram.js'
import * as tiktok from '../../platforms/tiktok.js'
import { getTokens, saveToken } from '../store.js'
import { extractExternalId, tiktokPublishId } from './externalId.js'
import {
  getPostsNeedingDiscovery, getTrackedPlatforms, createPostMetric,
  getDuePostMetrics, recordSnapshot,
} from './store.js'

// Tokens are per-user now — cache lookups within a single collection cycle
// so we don't re-query Postgres for every post/post_metric belonging to
// the same user.
function tokenCache() {
  const cache = new Map()
  return async (userId) => {
    if (!cache.has(userId)) cache.set(userId, await getTokens(userId))
    return cache.get(userId)
  }
}

// Discover new (post, platform) pairs to start tracking — a post's platform
// results become resolvable as soon as it's published; TikTok additionally
// needs its Direct Post upload to finish processing before a video ID exists.
async function discoverNewPostMetrics(getTokensForUser) {
  const posts = await getPostsNeedingDiscovery()

  for (const post of posts) {
    const tracked = await getTrackedPlatforms(post.id)
    const tokens = await getTokensForUser(post.user_id)

    for (const platform of post.platforms || []) {
      if (tracked.has(platform)) continue
      if (platform === 'linkedin') continue // no analytics API — never tracked

      let externalId = extractExternalId(platform, post.results)

      if (!externalId && platform === 'tiktok') {
        const publishId = tiktokPublishId(post.results)
        const tok = tokens.tiktok
        if (publishId && tok) {
          try {
            const { access_token, refreshed, newTok } = await tiktok.ensureFreshToken(tok)
            if (refreshed) { await saveToken(post.user_id, 'tiktok', newTok); tokens.tiktok = newTok }
            externalId = await tiktok.resolvePublishedVideoId(access_token, publishId)
          } catch (e) {
            console.warn('[analytics] tiktok resolve failed:', e.response?.data?.error?.message || e.message)
          }
        }
      }

      if (externalId) await createPostMetric(post.id, platform, externalId)
    }
  }
}

async function fetchMetrics(platform, tokens, userId) {
  return async (externalId) => {
    if (platform === 'x') {
      const tok = tokens.x
      if (!tok) return null
      return twitter.getPostMetrics(tok.access_token, externalId)
    }
    if (platform === 'youtube') {
      const tok = tokens.youtube
      if (!tok) return null
      const { access_token, refreshed, newTok } = await youtube.ensureFreshToken(tok)
      if (refreshed) { await saveToken(userId, 'youtube', newTok); tokens.youtube = newTok }
      return youtube.getVideoMetrics(access_token, externalId)
    }
    if (platform === 'facebook') {
      const tok = tokens.facebook
      if (!tok) return null
      return facebook.getPostMetrics(tok.pageToken, externalId)
    }
    if (platform === 'instagram') {
      const tok = tokens.instagram
      if (!tok) return null
      // Without instagram_manage_insights every insights call fails — skip
      // instead of hammering the Graph API (and the logs) each cycle. The UI
      // already flags this connection as needing a reconnect (analyticsReady).
      // An empty scope list means the grant lookup itself failed, so try anyway.
      if (tok.scopes?.length && !tok.scopes.includes('instagram_manage_insights')) return null
      return instagram.getMediaMetrics(tok.pageToken, externalId)
    }
    if (platform === 'tiktok') {
      const tok = tokens.tiktok
      if (!tok) return null
      const { access_token, refreshed, newTok } = await tiktok.ensureFreshToken(tok)
      if (refreshed) { await saveToken(userId, 'tiktok', newTok); tokens.tiktok = newTok }
      return tiktok.getVideoMetrics(access_token, externalId)
    }
    return null
  }
}

async function pollDueMetrics(getTokensForUser) {
  const due = await getDuePostMetrics()

  for (const pm of due) {
    try {
      const tokens = await getTokensForUser(pm.user_id)
      const fetcher = await fetchMetrics(pm.platform, tokens, pm.user_id)
      const metrics = await fetcher(pm.external_id)
      if (metrics) await recordSnapshot(pm.id, metrics)
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.response?.data?.message || e.message
      console.warn(`[analytics] poll failed for post_metric ${pm.id} (${pm.platform}):`, msg)
    }
  }
}

async function runCollectionCycle() {
  try {
    const getTokensForUser = tokenCache()
    await discoverNewPostMetrics(getTokensForUser)
    await pollDueMetrics(getTokensForUser)
  } catch (e) {
    console.error('[analytics] collection cycle failed:', e.message)
  }
}

export function startMetricsCollector() {
  // Runs every 5 minutes; getDuePostMetrics enforces the real cadence
  // (30 min for posts <48h old, daily for older ones) so this just needs
  // to be frequent enough not to miss the 30-minute window.
  cron.schedule('*/5 * * * *', runCollectionCycle)
  console.log('[analytics] Metrics collector running — checks every 5 minutes')
}

export { runCollectionCycle }
