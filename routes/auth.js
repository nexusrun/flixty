import { Router } from 'express'
import crypto from 'crypto'
import * as twitter from '../platforms/twitter.js'
import * as linkedin from '../platforms/linkedin.js'
import * as facebook from '../platforms/facebook.js'
import * as youtube from '../platforms/youtube.js'
import * as tiktok from '../platforms/tiktok.js'
import { saveToken, removeToken, getTokens } from '../lib/store.js'

const router = Router()
const SUCCESS_HTML = `<html><body><script>
  window.opener && window.opener.postMessage('oauth-success','*');
  window.close();
</script><p>Connected! You can close this window.</p></body></html>`

const fail = (res, msg) => res.status(400).send(`<p>Error: ${msg}</p>`)

// Status — which platforms are connected
router.get('/status', (_req, res) => {
  const tokens = getTokens()
  const status = {}
  for (const [p, d] of Object.entries(tokens)) {
    status[p] = { connected: true, savedAt: d.savedAt }
  }
  res.json(status)
})

// ── X / Twitter ──
router.get('/x', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex')
  req.session.xState = state
  res.redirect(twitter.getAuthUrl(state))
})
router.get('/x/callback', async (req, res) => {
  if (req.query.state !== req.session.xState) return fail(res, 'State mismatch')
  try {
    const tok = await twitter.exchangeCode(req.query.code, req.query.state)
    saveToken('x', tok)
    res.send(SUCCESS_HTML)
  } catch (e) { fail(res, e.response?.data?.error_description || e.message) }
})
router.delete('/x', (_req, res) => { removeToken('x'); res.json({ ok: true }) })

// ── LinkedIn ──
router.get('/linkedin', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex')
  req.session.liState = state
  res.redirect(linkedin.getAuthUrl(state))
})
router.get('/linkedin/callback', async (req, res) => {
  if (req.query.state !== req.session.liState) return fail(res, 'State mismatch')
  try {
    const tok = await linkedin.exchangeCode(req.query.code)
    const profile = await linkedin.getProfile(tok.access_token)
    saveToken('linkedin', { ...tok, personId: profile.id })
    res.send(SUCCESS_HTML)
  } catch (e) { fail(res, e.response?.data?.message || e.message) }
})
router.delete('/linkedin', (_req, res) => { removeToken('linkedin'); res.json({ ok: true }) })

// ── Facebook + Instagram (single OAuth flow) ──
router.get('/facebook', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex')
  req.session.fbState = state
  res.redirect(facebook.getAuthUrl(state))
})
router.get('/facebook/callback', async (req, res) => {
  if (req.query.state !== req.session.fbState) return fail(res, 'State mismatch')
  try {
    const tok = await facebook.exchangeCode(req.query.code)
    const pages = await facebook.getPages(tok.access_token)
    if (!pages.length) throw new Error('No Facebook Pages found — create a Page first.')
    const page = pages[0]
    saveToken('facebook', { userToken: tok.access_token, pageToken: page.access_token, pageId: page.id, pageName: page.name })
    const igId = await facebook.getInstagramAccountId(page.id, page.access_token)
    if (igId) saveToken('instagram', { pageToken: page.access_token, igAccountId: igId, pageId: page.id })
    res.send(SUCCESS_HTML)
  } catch (e) { fail(res, e.response?.data?.error?.message || e.message) }
})
router.delete('/facebook', (_req, res) => { removeToken('facebook'); removeToken('instagram'); res.json({ ok: true }) })

// ── TikTok ──
router.get('/tiktok', (req, res) => {
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
router.delete('/tiktok', (_req, res) => { removeToken('tiktok'); res.json({ ok: true }) })

// ── YouTube (Google OAuth) ──
router.get('/youtube', (req, res) => {
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
router.delete('/youtube', (_req, res) => { removeToken('youtube'); res.json({ ok: true }) })

export default router
