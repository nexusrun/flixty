// Pulls the platform-native post/media ID out of the `results[platform]` blob
// that routes/posts.js and lib/scheduler.js already save on every publish.
// Returns null when the platform can't be tracked (not published, or no
// analytics API — LinkedIn) or isn't resolvable yet (TikTok, until processed).
export function extractExternalId(platform, results) {
  const r = results?.[platform]
  if (!r) return null

  switch (platform) {
    case 'x':         return r.data?.id || null
    case 'facebook':  return r.id || null
    case 'instagram': return r.id || null
    case 'youtube':   return r.id || null
    case 'tiktok':     return null // resolved separately via resolvePublishedVideoId (publish_id -> real video id)
    case 'linkedin':   return null // no analytics API for personal-profile posts
    default:            return null
  }
}

export function tiktokPublishId(results) {
  return results?.tiktok?.publish_id || null
}
