import { query } from './db/pool.js'

// ── Tokens ──

export async function getTokens(userId) {
  const { rows } = await query('SELECT platform, data, saved_at FROM oauth_tokens WHERE user_id = $1', [userId])
  const out = {}
  for (const r of rows) out[r.platform] = { ...r.data, savedAt: new Date(r.saved_at).getTime() }
  return out
}

export async function saveToken(userId, platform, data) {
  await query(
    `INSERT INTO oauth_tokens (user_id, platform, data, saved_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, platform) DO UPDATE SET data = $3, saved_at = now()`,
    [userId, platform, data]
  )
}

export async function removeToken(userId, platform) {
  await query('DELETE FROM oauth_tokens WHERE user_id = $1 AND platform = $2', [userId, platform])
}

// Facebook's data-deletion webhook has no session — only Facebook's own user_id
// (stashed in data.fbUserId at connect time) — so this is the only way to find
// which of our users the request applies to.
export async function findUserIdByFacebookId(fbUserId) {
  const { rows } = await query(
    `SELECT user_id FROM oauth_tokens WHERE platform = 'facebook' AND data->>'fbUserId' = $1`,
    [fbUserId]
  )
  return rows[0]?.user_id ?? null
}

// ── Posts ──

function rowToPost(r) {
  return {
    id: r.id,
    text: r.text,
    platforms: r.platforms,
    mediaUrl: r.media_url,
    results: r.results,
    errors: r.errors,
    ...r.meta,
    createdAt: r.created_at?.toISOString?.() ?? r.created_at,
    publishedAt: r.published_at ? (r.published_at.toISOString?.() ?? r.published_at) : (r.meta?.publishedAt ?? undefined),
  }
}

export async function getPosts(userId) {
  const { rows } = await query('SELECT * FROM posts WHERE user_id = $1 ORDER BY created_at DESC', [userId])
  return rows.map(rowToPost)
}

// Clears the "pending" flag on a manually-posted platform (X/TikTok web
// intent flow) once the user confirms they finished posting on the platform's
// own site. Ownership-checked via user_id, silently no-ops if not found/owned.
export async function markPlatformPosted(userId, postId, platform) {
  const { rows } = await query('SELECT results FROM posts WHERE id = $1 AND user_id = $2', [postId, userId])
  if (!rows[0]) return null
  const results = rows[0].results || {}
  if (!results[platform]) return null
  results[platform] = { ...results[platform], pending: false }
  const { rows: updated } = await query('UPDATE posts SET results = $1 WHERE id = $2 RETURNING *', [results, postId])
  return rowToPost(updated[0])
}

export async function savePost(userId, post) {
  const { text, platforms = [], mediaUrl = null, results = {}, errors = {}, publishedAt, ...rest } = post
  const { rows } = await query(
    `INSERT INTO posts (user_id, text, platforms, media_url, results, errors, meta, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [userId, text, platforms, mediaUrl, results, errors, rest, publishedAt || null]
  )
  return rowToPost(rows[0])
}

// ── Scheduled posts ──

function rowToScheduled(r) {
  return {
    id: r.id,
    text: r.text,
    platforms: r.platforms,
    scheduledAt: r.scheduled_at.toISOString(),
    imageUrl: r.image_url,
    campaignName: r.campaign_name,
    videoPath: r.video_path,
    mimeType: r.mime_type,
    createdAt: r.created_at.toISOString(),
  }
}

export async function getScheduled(userId) {
  const { rows } = await query('SELECT * FROM scheduled_posts WHERE user_id = $1 ORDER BY scheduled_at ASC', [userId])
  return rows.map(rowToScheduled)
}

export async function saveScheduled(userId, post) {
  const { text, platforms = [], scheduledAt, imageUrl = null, campaignName = null, videoPath = null, mimeType = null } = post
  const { rows } = await query(
    `INSERT INTO scheduled_posts (user_id, text, platforms, scheduled_at, image_url, campaign_name, video_path, mime_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [userId, text, platforms, scheduledAt, imageUrl, campaignName, videoPath, mimeType]
  )
  return rowToScheduled(rows[0])
}

export async function removeScheduled(userId, id) {
  await query('DELETE FROM scheduled_posts WHERE id = $1 AND user_id = $2', [id, userId])
}

// Every scheduled post across all users that's due — used only by the scheduler,
// which then resolves each post's own tokens by its user_id.
export async function getAllDueScheduled() {
  const { rows } = await query('SELECT *, user_id AS "userId" FROM scheduled_posts WHERE scheduled_at <= now()')
  return rows.map(r => ({ ...rowToScheduled(r), userId: r.userId }))
}

// ── Users ──

function rowToUser(r) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    passwordHash: r.password_hash,
    googleId: r.google_id,
    createdAt: r.created_at.toISOString(),
  }
}

export async function getUsers() {
  const { rows } = await query('SELECT * FROM users ORDER BY created_at ASC')
  return rows.map(rowToUser)
}

export async function findUserByEmail(email) {
  const { rows } = await query('SELECT * FROM users WHERE lower(email) = lower($1)', [email])
  return rows[0] ? rowToUser(rows[0]) : undefined
}

export async function findUserById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id])
  return rows[0] ? rowToUser(rows[0]) : undefined
}

export async function createUser(user) {
  const { name, email, passwordHash = null, googleId = null } = user
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, google_id) VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, email, passwordHash, googleId]
  )
  return rowToUser(rows[0])
}

// ── Live sessions ──

function rowToLive(r) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    platforms: r.platforms,
    results: r.results,
    errors: r.errors,
    status: r.status,
    startedAt: r.started_at.toISOString(),
    endedAt: r.ended_at ? r.ended_at.toISOString() : undefined,
  }
}

export async function getLives(userId) {
  const { rows } = await query('SELECT * FROM live_sessions WHERE user_id = $1 ORDER BY started_at DESC', [userId])
  return rows.map(rowToLive)
}

export async function saveLive(userId, item) {
  const { title = null, description = null, platforms = [], results = {}, errors = {} } = item
  const { rows } = await query(
    `INSERT INTO live_sessions (user_id, title, description, platforms, results, errors)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [userId, title, description, platforms, results, errors]
  )
  return rowToLive(rows[0])
}

export async function updateLive(userId, id, updates) {
  const sets = []
  const values = []
  let i = 1

  if (updates.endedAt !== undefined) { sets.push(`ended_at = $${i++}`); values.push(updates.endedAt) }
  if (updates.status !== undefined) { sets.push(`status = $${i++}`); values.push(updates.status) }
  if (updates.results !== undefined) { sets.push(`results = $${i++}`); values.push(updates.results) }
  if (updates.errors !== undefined) { sets.push(`errors = $${i++}`); values.push(updates.errors) }
  if (!sets.length) return

  values.push(id, userId)
  await query(`UPDATE live_sessions SET ${sets.join(', ')} WHERE id = $${i++} AND user_id = $${i}`, values)
}
