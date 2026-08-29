import { Router } from 'express'
import crypto from 'crypto'
import * as twitter from '../platforms/twitter.js'
import * as linkedin from '../platforms/linkedin.js'
import * as facebook from '../platforms/facebook.js'
import * as youtube from '../platforms/youtube.js'
import * as tiktok from '../platforms/tiktok.js'
import { saveToken, removeToken, getTokens, findUserIdByFacebookId } from '../lib/store.js'
import { requireAuth } from '../lib/auth.js'

const router = Router()
const SUCCESS_HTML = `<html><body><script>
  window.opener && window.opener.postMessage('oauth-success','*');
  window.close();
</script><p>Connected! You can close this window.</p></body></html>`

const fail = (res, msg) => res.status(400).send(`<p>Error: ${msg}</p>`)

// Status — which platforms are connected + display names, for the logged-in user
router.get('/status', requireAuth, async (req, res) => {
  const tokens = await getTokens(req.session.userId)
  const status = {}
  for (const [p, d] of Object.entries(tokens)) {
    status[p] = {
      connected: true,
      savedAt: d.savedAt,
      displayName: d.displayName || null,
      username: d.username || null,
      pageName: d.pageName || null,
      activeAccountId: d.activeAccountId || null,
      accounts: (d.accounts || []).map(a => ({ id: a.id, name: a.name, type: a.type, pageId: a.pageId || null, pageName: a.pageName || null })),
    }
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
  if (!req.session.userId) return fail(res, 'Session expired — please log in and try connecting again')
  if (req.query.state !== req.session.xState) return fail(res, 'State mismatch')
  try {
    const tok = await twitter.exchangeCode(req.query.code, req.query.state)
    const user = await twitter.getUser(tok.access_token)
    await saveToken(req.session.userId, 'x', { ...tok, displayName: user.name, username: user.username })
    res.send(SUCCESS_HTML)
  } catch (e) { fail(res, e.response?.data?.error_description || e.message) }
})
router.delete('/x', requireAuth, async (req, res) => { await removeToken(req.session.userId, 'x'); res.json({ ok: true }) })

// ── LinkedIn ──
router.get('/linkedin', requireAuth, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex')
  req.session.liState = state
  res.redirect(linkedin.getAuthUrl(state))
})
router.get('/linkedin/callback', async (req, res) => {
  if (!req.session.userId) return fail(res, 'Session expired — please log in and try connecting again')
  if (req.query.state !== req.session.liState) return fail(res, 'State mismatch')
  try {
    const tok = await linkedin.exchangeCode(req.query.code)
    const profile = await linkedin.getProfile(tok.access_token)
    const organizations = await linkedin.getOrganizations(tok.access_token)
    const accounts = [
      { id: String(profile.sub), name: profile.name || 'Personal LinkedIn', type: 'person' },
      ...organizations,
    ]
    await saveToken(req.session.userId, 'linkedin', { ...tok, personId: profile.sub, displayName: profile.name || null, username: profile.email || null, accounts, activeAccountId: String(profile.sub) })
    res.send(SUCCESS_HTML)
  } catch (e) { fail(res, e.response?.data?.message || e.message) }
})
router.delete('/linkedin', requireAuth, async (req, res) => { await removeToken(req.session.userId, 'linkedin'); res.json({ ok: true }) })

// Select which connected identity should receive future posts. Tokens remain
// server-side; the client sends only an account id from /auth/status.
router.patch('/select', requireAuth, async (req, res) => {
  const { platform, accountId } = req.body || {}
  if (!['linkedin', 'facebook', 'instagram'].includes(platform) || !accountId) {
    return res.status(400).json({ error: 'platform and accountId are required' })
  }
  const tokens = await getTokens(req.session.userId)
  const token = tokens[platform]
  const account = token?.accounts?.find(a => String(a.id) === String(accountId))
  if (!account) return res.status(404).json({ error: 'Account is not connected' })

  const next = { ...token, activeAccountId: String(account.id) }
  if (platform === 'linkedin') {
    next.personId = account.type === 'person' ? account.id : next.personId
    next.displayName = account.name
  } else if (platform === 'facebook') {
    next.pageId = account.id; next.pageName = account.name; next.pageToken = account.pageToken
  } else {
    next.igAccountId = account.id; next.pageId = account.pageId; next.pageName = account.pageName; next.pageToken = account.pageToken
  }
  await saveToken(req.session.userId, platform, next)
  res.json({ ok: true, platform, activeAccountId: String(account.id), account: { id: account.id, name: account.name, type: account.type } })
})

// ── Facebook + Instagram (single OAuth flow) ──
router.get('/facebook', requireAuth, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex')
  req.session.fbState = state
  res.redirect(facebook.getAuthUrl(state))
})
router.get('/facebook/callback', async (req, res) => {
  if (!req.session.userId) return fail(res, 'Session expired — please log in and try connecting again')
  if (req.query.state !== req.session.fbState) return fail(res, 'State mismatch')
  try {
    const tok = await facebook.exchangeCode(req.query.code)
    const [pages, fbUserId] = await Promise.all([
      facebook.getPages(tok.access_token),
      facebook.getMe(tok.access_token),
    ])
    console.log('[facebook] pages response:', JSON.stringify(pages))
    if (!pages.length) throw new Error(
      'No Facebook Pages found. Make sure: (1) you have a Facebook Page, ' +
      '(2) your app has pages_show_list scope, (3) you are an Admin of the Page.'
    )
    const page = pages[0]
    const pageAccounts = pages.map(p => ({ id: String(p.id), name: p.name, type: 'page', pageToken: p.access_token }))
    await saveToken(req.session.userId, 'facebook', { userToken: tok.access_token, pageToken: page.access_token, pageId: page.id, pageName: page.name, fbUserId, accounts: pageAccounts, activeAccountId: String(page.id) })

    // The linked Instagram Business Account can be on any of the user's
    // pages, not necessarily the first one — check them all rather than
    // only ever looking at pages[0].
    const instagramAccounts = []
    for (const p of pages) {
      const igId = await facebook.getInstagramAccountId(p.id, p.access_token)
      if (igId) instagramAccounts.push({ id: String(igId), name: `${p.name} Instagram`, type: 'instagram', pageId: String(p.id), pageName: p.name, pageToken: p.access_token })
    }
    if (instagramAccounts.length) {
      console.log(`[instagram] linked ${instagramAccounts.length} account(s) via Facebook:`, instagramAccounts.map(a => `${a.id} (${a.pageName})`).join(', '))
      const ig = instagramAccounts[0]
      await saveToken(req.session.userId, 'instagram', { pageToken: ig.pageToken, igAccountId: ig.id, pageId: ig.pageId, pageName: ig.pageName, accounts: instagramAccounts, activeAccountId: ig.id })
    } else {
      // No Instagram saved — almost always means no Page has an Instagram
      // professional account linked in Meta's settings, or the granted token
      // is missing instagram_basic. Log it so this isn't a silent no-op.
      console.log(`[instagram] no linked Instagram professional account found across ${pages.length} page(s) — not connecting Instagram`)
    }
    res.send(SUCCESS_HTML)
  } catch (e) { fail(res, e.response?.data?.error?.message || e.message) }
})
router.delete('/facebook', requireAuth, async (req, res) => {
  await removeToken(req.session.userId, 'facebook')
  await removeToken(req.session.userId, 'instagram')
  res.json({ ok: true })
})

// ── TikTok ──
router.get('/tiktok', requireAuth, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex')
  req.session.ttState = state
  res.redirect(tiktok.getAuthUrl(state))
})
router.get('/tiktok/callback', async (req, res) => {
  if (!req.session.userId) return fail(res, 'Session expired — please log in and try connecting again')
  if (req.query.state !== req.session.ttState) return fail(res, 'State mismatch')
  try {
    const tok  = await tiktok.exchangeCode(req.query.code, req.query.state)
    const user = await tiktok.getUserInfo(tok.access_token)
    await saveToken(req.session.userId, 'tiktok', { ...tok, displayName: user.display_name, openId: user.open_id })
    res.send(SUCCESS_HTML)
  } catch (e) { fail(res, e.response?.data?.message || e.message) }
})
router.delete('/tiktok', requireAuth, async (req, res) => { await removeToken(req.session.userId, 'tiktok'); res.json({ ok: true }) })

// ── YouTube (Google OAuth) ──
router.get('/youtube', requireAuth, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex')
  req.session.ytState = state
  res.redirect(youtube.getAuthUrl(state))
})
router.get('/youtube/callback', async (req, res) => {
  if (!req.session.userId) return fail(res, 'Session expired — please log in and try connecting again')
  if (req.query.state !== req.session.ytState) return fail(res, 'State mismatch')
  try {
    const tok = await youtube.exchangeCode(req.query.code)
    const channelTitle = await youtube.getChannelTitle(tok.access_token)
    await saveToken(req.session.userId, 'youtube', { ...tok, channelTitle })
    res.send(SUCCESS_HTML)
  } catch (e) { fail(res, e.response?.data?.error_description || e.message) }
})
router.delete('/youtube', requireAuth, async (req, res) => { await removeToken(req.session.userId, 'youtube'); res.json({ ok: true }) })

// ── Facebook Data Deletion Callback ──
// Required by Facebook for apps using Facebook Login.
// Facebook sends a signed_request identifying its own user_id — no session
// context here, so we look up which of our users connected that Facebook
// account and delete only that user's Facebook/Instagram data.
router.post('/facebook/data-deletion', async (req, res) => {
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

    const userId = await findUserIdByFacebookId(String(data.user_id))
    if (userId) {
      await removeToken(userId, 'facebook')
      await removeToken(userId, 'instagram')
    }

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
