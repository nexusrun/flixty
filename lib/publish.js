import * as linkedin from '../platforms/linkedin.js'
import * as facebook from '../platforms/facebook.js'
import * as instagram from '../platforms/instagram.js'
import * as youtube from '../platforms/youtube.js'
import { getTokens, saveToken } from './store.js'
import { buildXWebAction, buildTiktokWebAction } from './webPublish.js'

// Shared by the immediate-publish route, the scheduler, and MCP tools.
//
// `media` describes the attached image/video, or is null/undefined for
// text-only posts:
//   { url, filePath, mimeType }
//   - url: a publicly reachable URL (used for Facebook photo posts and
//     Instagram, which accept a URL directly)
//   - filePath: a local file path (used for Facebook video posts and
//     YouTube, which upload the file directly)
//
// X and TikTok never touch their APIs — see lib/webPublish.js.
export async function publishToPlatforms(userId, { text, platforms, media = null, campaignName }) {
  const tokens = await getTokens(userId)
  const results = {}, errors = {}

  if (platforms.includes('x')) results.x = buildXWebAction(text)
  if (platforms.includes('tiktok')) results.tiktok = buildTiktokWebAction(text, media?.url || null)

  await Promise.allSettled(platforms.filter(p => p !== 'x' && p !== 'tiktok').map(async platform => {
    const tok = tokens[platform]
    if (!tok) { errors[platform] = 'Not connected — visit /auth/' + platform; return }
    try {
      if (platform === 'linkedin') results.linkedin = await linkedin.postUpdate(tok.access_token, tok.personId, text)

      if (platform === 'facebook') {
        const isVideo = media?.mimeType?.startsWith('video/')
        if (isVideo && media.filePath) {
          results.facebook = await facebook.postVideoToPage(tok.pageToken, tok.pageId, text, media.filePath)
        } else if (media?.url) {
          results.facebook = await facebook.postPhotoToPage(tok.pageToken, tok.pageId, text, media.url)
        } else {
          results.facebook = await facebook.postToPage(tok.pageToken, tok.pageId, text)
        }
      }

      if (platform === 'instagram') {
        if (!media?.url) { errors.instagram = 'Instagram requires an image URL'; return }
        results.instagram = await instagram.post(tok.igAccountId, tok.pageToken, { imageUrl: media.url, caption: text })
      }

      if (platform === 'youtube') {
        if (!media?.filePath) { errors.youtube = 'YouTube requires a video file'; return }
        if (media.mimeType && !media.mimeType.startsWith('video/')) { errors.youtube = `YouTube only supports video files — got ${media.mimeType}`; return }
        const { access_token, refreshed, newTok } = await youtube.ensureFreshToken(tok)
        if (refreshed) await saveToken(userId, 'youtube', newTok)
        const title = (campaignName || text.split('\n')[0] || 'Untitled').slice(0, 100)
        results.youtube = await youtube.uploadVideo(access_token, media.filePath, { title, description: text, mimeType: media.mimeType || 'video/mp4' })
      }
    } catch (e) {
      errors[platform] = e.response?.data?.error?.message
                      || e.response?.data?.detail
                      || e.response?.data?.message
                      || e.message
    }
  }))

  return { results, errors }
}
