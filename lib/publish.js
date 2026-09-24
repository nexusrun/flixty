import * as linkedin from '../platforms/linkedin.js'
import * as facebook from '../platforms/facebook.js'
import * as instagram from '../platforms/instagram.js'
import * as youtube from '../platforms/youtube.js'
import * as tiktok from '../platforms/tiktok.js'
import { getTokens, saveToken } from './store.js'
import { buildXWebAction } from './webPublish.js'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const UPLOADS_DIR = path.resolve('./data/uploads')

// Instagram's Graph API only accepts JPEG images. For an image that lives in
// our own uploads dir (a file upload, or an earlier PNG AI image referenced by
// URL) in any other format, write a JPEG copy next to it and hand Instagram
// that URL instead. Remote URLs and videos pass through unchanged.
async function instagramReadyMedia(media) {
  if (!media || media.mimeType?.startsWith('video/')) return media
  let filePath = media.filePath
  const uploadsPrefix = `${process.env.BASE_URL}/uploads/`
  if (!filePath && media.url?.startsWith(uploadsPrefix)) {
    filePath = path.join(UPLOADS_DIR, path.basename(decodeURIComponent(media.url.slice(uploadsPrefix.length))))
  }
  if (!filePath || !/\.(png|webp|gif)$/i.test(filePath) || !fs.existsSync(filePath)) return media

  const sharp = (await import('sharp')).default
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`
  await sharp(filePath).flatten({ background: '#ffffff' }).jpeg({ quality: 95, mozjpeg: true }).toFile(path.join(UPLOADS_DIR, filename))
  return { ...media, filePath: path.join(UPLOADS_DIR, filename), mimeType: 'image/jpeg', url: uploadsPrefix + filename }
}

// Shared by the immediate-publish route, the scheduler, and MCP tools.
//
// `media` describes the attached image/video, or is null/undefined for
// text-only posts:
//   { url, filePath, mimeType }
//   - url: a publicly reachable URL (used for Facebook photo posts and
//     Instagram, which accept a URL directly)
//   - filePath: a local file path (used for Facebook video posts and
//     YouTube/TikTok, which upload the file directly)
//
// `thumbnail` is a separate optional image `{ filePath, mimeType }` — only
// meaningful for YouTube, which is the one platform with its own distinct
// thumbnail-upload API. Setting it is best-effort: YouTube rejects custom
// thumbnails for unverified channels, and that shouldn't fail a video that
// otherwise published fine — a failure here is recorded on the result
// instead of thrown.
//
// X still never touches its API (needs paid access) — see lib/webPublish.js.
// TikTok posts through the real Content Posting API in sandbox mode
// (SELF_ONLY privacy — private, visible only to the connected sandbox
// account — doesn't require full app review).
export async function publishToPlatforms(userId, { text, platforms, media = null, thumbnail = null, campaignName, accountTargets = {} }) {
  const tokens = await getTokens(userId)
  const results = {}, errors = {}

  if (platforms.includes('x')) results.x = buildXWebAction(text)

  await Promise.allSettled(platforms.filter(p => p !== 'x').map(async platform => {
    const baseTok = tokens[platform]
    const targetId = accountTargets[platform]
    const selected = targetId && baseTok?.accounts?.find(a => String(a.id) === String(targetId))
    const tok = selected ? { ...baseTok, ...selected, pageToken: selected.pageToken || baseTok.pageToken } : baseTok
    if (!tok) {
      // Instagram has no OAuth flow of its own — it's linked through Facebook.
      errors[platform] = platform === 'instagram'
        ? 'Instagram not connected — connect Facebook (with a Page that has a linked Instagram professional account)'
        : 'Not connected — visit /auth/' + platform
      return
    }
    if (targetId && !selected) { errors[platform] = 'Selected account is no longer connected'; return }
    try {
      if (platform === 'linkedin') {
        const account = selected || (tok.activeAccountId && tok.accounts?.find(a => String(a.id) === String(tok.activeAccountId))) || { id: tok.personId, type: 'person' }
        results.linkedin = await linkedin.postUpdate(tok.access_token, account, text)
      }

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
        if (!media?.url) { errors.instagram = 'Instagram requires an image or video'; return }
        results.instagram = await instagram.post(tok.igAccountId, tok.pageToken, { media: await instagramReadyMedia(media), caption: text })
      }

      if (platform === 'tiktok') {
        if (!media?.filePath) { errors.tiktok = 'TikTok requires a video file'; return }
        if (media.mimeType && !media.mimeType.startsWith('video/')) { errors.tiktok = `TikTok only supports video files — got ${media.mimeType}`; return }
        // Sandbox mode only allows SELF_ONLY (private, visible to the
        // connected sandbox account only) — PUBLIC_TO_EVERYONE needs full
        // TikTok app review approval.
        const { access_token, refreshed, newTok } = await tiktok.ensureFreshToken(tok)
        if (refreshed) await saveToken(userId, 'tiktok', newTok)
        results.tiktok = await tiktok.uploadVideo(access_token, media.filePath, { caption: text, privacyLevel: 'SELF_ONLY' })
      }

      if (platform === 'youtube') {
        if (!media?.filePath) { errors.youtube = 'YouTube requires a video file'; return }
        if (media.mimeType && !media.mimeType.startsWith('video/')) { errors.youtube = `YouTube only supports video files — got ${media.mimeType}`; return }
        const { access_token, refreshed, newTok } = await youtube.ensureFreshToken(tok)
        if (refreshed) await saveToken(userId, 'youtube', newTok)
        const title = (campaignName || text.split('\n')[0] || 'Untitled').slice(0, 100)
        results.youtube = await youtube.uploadVideo(access_token, media.filePath, { title, description: text, mimeType: media.mimeType || 'video/mp4' })

        if (thumbnail?.filePath) {
          try {
            await youtube.setThumbnail(access_token, results.youtube.id, thumbnail.filePath, thumbnail.mimeType)
          } catch (e) {
            results.youtube.thumbnailError = e.response?.data?.error?.message || e.message
          }
        }
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
