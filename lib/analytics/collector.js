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

// Discover new (post, platform) pairs to start tracking — a post's platform
// results become resolvable as soon as it's published; TikTok additionally
// needs its Direct Post upload to finish processing before a video ID exists.
async function discoverNewPostMetrics(tokens) {
  const posts = await getPostsNeedingDiscovery()

  for (const post of posts) {
    const tracked = await getTrackedPlatforms(post.id)

    for (const platform of post.platforms || []) {
      if (tracked.has(platform)) continue
      if (platform === 'linkedin') continue // no analytics API — never tracked

      let externalId = extractExternalId(platform, post.results)

      if (!externalId && platform === 'tiktok') {
        const publishId = tiktokPublishId(post.results)
        const tok = tokens.tiktok
        if (publishId && tok) {
          try {
            externalId = await tiktok.resolvePublishedVideoId(tok.access_token, publishId)
          } catch (e) {
            console.warn('[analytics] tiktok resolve failed:', e.response?.data?.error?.message || e.message)
          }
        }
      }

      if (externalId) await createPostMetric(post.id, platform, externalId)
    }
  }
}

async function fetchMetrics(platform, tokens) {
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
      if (refreshed) await saveToken('youtube', newTok)
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
      return instagram.getMediaMetrics(tok.pageToken, externalId)
    }
    if (platform === 'tiktok') {
      const tok = tokens.tiktok
      if (!tok) return null
      return tiktok.getVideoMetrics(tok.access_token, externalId)
    }
    return null
  }
}

async function pollDueMetrics(tokens) {
  const due = await getDuePostMetrics()

  for (const pm of due) {
    try {
      const fetcher = await fetchMetrics(pm.platform, tokens)
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
    const tokens = await getTokens()
    await discoverNewPostMetrics(tokens)
    await pollDueMetrics(tokens)
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
