// X and TikTok posting normally goes through their APIs, which need paid API
// access (X) or app review approval (TikTok) that can be hard to get. As a
// workaround, these two platforms are "posted" by opening the platform's own
// web interface pre-filled (X) or ready (TikTok) for the user to finish
// manually — no API credentials involved at all.
//
// Because the actual post happens on the platform's own site, we never get
// back a post ID, so these can't be tracked by the analytics collector —
// that's an inherent tradeoff of not using the API.

export function buildXWebAction(text) {
  return {
    webIntent: true,
    pending: true,
    url: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`,
  }
}

export function buildTiktokWebAction(text, mediaUrl) {
  return {
    webUpload: true,
    pending: true,
    url: 'https://www.tiktok.com/upload?lang=en',
    caption: text,
    downloadUrl: mediaUrl || null,
  }
}
