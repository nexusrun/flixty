import { Router } from 'express'
import crypto from 'crypto'
import * as twitter from '../platforms/twitter.js'
import * as linkedin from '../platforms/linkedin.js'
import * as facebook from '../platforms/facebook.js'
import * as youtube from '../platforms/youtube.js'
import * as tiktok from '../platforms/tiktok.js'
import { saveToken, removeToken, getTokens } from '../lib/store.js'
import { requireAuth } from '../lib/auth.js'

const router = Router()
const SUCCESS_HTML = `<html><body><script>
  window.opener && window.opener.postMessage('oauth-success','*');
  window.close();
</script><p>Connected! You can close this window.</p></body></html>`

const fail = (res, msg) => res.status(400).send(`<p>Error: ${msg}</p>`)

// Status — which platforms are connected + display names
router.get('/status', (_req, res) => {
  const tokens = getTokens()
  const status = {}
  for (const [p, d] of Object.entries(tokens)) {
    status[p] = { connected: true, savedAt: d.savedAt, displayName: d.displayName || null, username: d.username || null, pageName: d.pageName || null }
  }
  res.json(status)
})

// ── X / Twitter ──
router.get('/x', requireAuth, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex')
  req.session.xState = state
  res.redirect(twitter.getAuthUrl(state))
})
router.get('/x/callback', async (req, res) => {
  if (req.query.state !== req.session.xState) return fail(res, 'State mismatch')
  try {
    const tok = await twitter.exchangeCode(req.query.code, req.query.state)
    const user = await twitter.getUser(tok.access_token)
    saveToken('x', { ...tok, displayName: user.name, username: user.username })
    res.send(SUCCESS_HTML)
  } catch (e) { fail(res, e.response?.data?.error_description || e.message) }
})
router.delete('/x', requireAuth, (_req, res) => { removeToken('x'); res.json({ ok: true }) })

// ── LinkedIn ──
router.get('/linkedin', requireAuth, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex')
  req.session.liState = state
  res.redirect(linkedin.getAuthUrl(state))
})
router.get('/linkedin/callback', async (req, res) => {
  if (req.query.state !== req.session.liState) return fail(res, 'State mismatch')
  try {
    const tok = await linkedin.exchangeCode(req.query.code)
    const profile = await linkedin.getProfile(tok.access_token)
    saveToken('linkedin', { ...tok, personId: profile.sub, displayName: profile.name || null, username: profile.email || null })
    res.send(SUCCESS_HTML)
  } catch (e) { fail(res, e.response?.data?.message || e.message) }
})
router.delete('/linkedin', requireAuth, (_req, res) => { removeToken('linkedin'); res.json({ ok: true }) })

// ── Facebook + Instagram (single OAuth flow) ──
router.get('/facebook', requireAuth, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex')
  req.session.fbState = state
  res.redirect(facebook.getAuthUrl(state))
})
router.get('/facebook/callback', async (req, res) => {
  if (req.query.state !== req.session.fbState) return fail(res, 'State mismatch')
  try {
    const tok = await facebook.exchangeCode(req.query.code)
    const pages = await facebook.getPages(tok.access_token)
    console.log('[facebook] pages response:', JSON.stringify(pages))
    if (!pages.length) throw new Error(
      'No Facebook Pages found. Make sure: (1) you have a Facebook Page, ' +
      '(2) your app has pages_show_list scope, (3) you are an Admin of the Page.'
    )
    const page = pages[0]
    saveToken('facebook', { userToken: tok.access_token, pageToken: page.access_token, pageId: page.id, pageName: page.name })
    const igId = await facebook.getInstagramAccountId(page.id, page.access_token)
    if (igId) saveToken('instagram', { pageToken: page.access_token, igAccountId: igId, pageId: page.id })
    res.send(SUCCESS_HTML)
  } catch (e) { fail(res, e.response?.data?.error?.message || e.message) }
})
router.delete('/facebook', requireAuth, (_req, res) => { removeToken('facebook'); removeToken('instagram'); res.json({ ok: true }) })

// ── TikTok ──
router.get('/tiktok', requireAuth, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex')
  req.session.ttState = state
  res.redirect(tiktok.getAuthUrl(state))
})
router.get('/tiktok/callback', async (req, res) => {
  if (req.query.state !== req.session.ttState) return fail(res, 'State mismatch')
  try {
    const tok  = await tiktok.exchangeCode(req.query.code, req.query.state)
    const user = await tiktok.getUserInfo(tok.access_token)
    saveToken('tiktok', { ...tok, displayName: user.display_name, openId: user.open_id })
    res.send(SUCCESS_HTML)
  } catch (e) { fail(res, e.response?.data?.message || e.message) }
})
router.delete('/tiktok', requireAuth, (_req, res) => { removeToken('tiktok'); res.json({ ok: true }) })

// ── YouTube (Google OAuth) ──
router.get('/youtube', requireAuth, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex')
  req.session.ytState = state
  res.redirect(youtube.getAuthUrl(state))
})
router.get('/youtube/callback', async (req, res) => {
  if (req.query.state !== req.session.ytState) return fail(res, 'State mismatch')
  try {
    const tok = await youtube.exchangeCode(req.query.code)
    const channelTitle = await youtube.getChannelTitle(tok.access_token)
    saveToken('youtube', { ...tok, channelTitle })
    res.send(SUCCESS_HTML)
  } catch (e) { fail(res, e.response?.data?.error_description || e.message) }
})
router.delete('/youtube', requireAuth, (_req, res) => { removeToken('youtube'); res.json({ ok: true }) })

// ── Facebook Data Deletion Callback ──
// Required by Facebook for apps using Facebook Login.
// Facebook sends a signed_request; we delete all stored Facebook/Instagram data
// and return a confirmation URL the user can visit to verify deletion.
router.post('/facebook/data-deletion', (req, res) => {
  try {
    const signedRequest = req.body.signed_request
    if (!signedRequest) return res.status(400).json({ error: 'Missing signed_request' })

    const [encodedSig, payload] = signedRequest.split('.')
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))

    // Verify HMAC-SHA256 signature
    const expectedSig = crypto
      .createHmac('sha256', process.env.FB_APP_SECRET)
      .update(payload)
      .digest('base64url')

    if (encodedSig !== expectedSig) return res.status(403).json({ error: 'Invalid signature' })

    // Delete all Facebook and Instagram data for this user
    removeToken('facebook')
    removeToken('instagram')

    const confirmationCode = `del_${data.user_id}_${Date.now()}`
    res.json({
      url: `${process.env.BASE_URL}/deletion-status?code=${confirmationCode}`,
      confirmation_code: confirmationCode,
    })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Deletion status page — shown to users who want to confirm their data was deleted
const escHtml = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;')
router.get('/facebook/deletion-status', (req, res) => {
  const code = escHtml(req.query.code || '')
  res.send(`<html><body style="font-family:sans-serif;padding:2rem">
    <h2>Data Deletion Confirmed</h2>
    <p>Your Facebook and Instagram data has been removed from Flixty.</p>
    ${code ? `<p>Confirmation code: <code>${code}</code></p>` : ''}
  </body></html>`)
})

export default router
