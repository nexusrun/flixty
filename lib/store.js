import { query } from './db/pool.js'

// ── Tokens ──

export async function getTokens() {
  const { rows } = await query('SELECT platform, data, saved_at FROM oauth_tokens')
  const out = {}
  for (const r of rows) out[r.platform] = { ...r.data, savedAt: new Date(r.saved_at).getTime() }
  return out
}

export async function saveToken(platform, data) {
  await query(
    `INSERT INTO oauth_tokens (platform, data, saved_at) VALUES ($1, $2, now())
     ON CONFLICT (platform) DO UPDATE SET data = $2, saved_at = now()`,
    [platform, data]
  )
}

export async function removeToken(platform) {
  await query('DELETE FROM oauth_tokens WHERE platform = $1', [platform])
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

export async function getPosts() {
  const { rows } = await query('SELECT * FROM posts ORDER BY created_at DESC')
  return rows.map(rowToPost)
}

export async function savePost(post) {
  const { text, platforms = [], mediaUrl = null, results = {}, errors = {}, publishedAt, ...rest } = post
  const { rows } = await query(
    `INSERT INTO posts (text, platforms, media_url, results, errors, meta, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [text, platforms, mediaUrl, results, errors, rest, publishedAt || null]
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

export async function getScheduled() {
  const { rows } = await query('SELECT * FROM scheduled_posts ORDER BY scheduled_at ASC')
  return rows.map(rowToScheduled)
}

export async function saveScheduled(post) {
  const { text, platforms = [], scheduledAt, imageUrl = null, campaignName = null, videoPath = null, mimeType = null } = post
  const { rows } = await query(
    `INSERT INTO scheduled_posts (text, platforms, scheduled_at, image_url, campaign_name, video_path, mime_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [text, platforms, scheduledAt, imageUrl, campaignName, videoPath, mimeType]
  )
  return rowToScheduled(rows[0])
}

export async function removeScheduled(id) {
  await query('DELETE FROM scheduled_posts WHERE id = $1', [id])
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

export async function getLives() {
  const { rows } = await query('SELECT * FROM live_sessions ORDER BY started_at DESC')
  return rows.map(rowToLive)
}

export async function saveLive(item) {
  const { title = null, description = null, platforms = [], results = {}, errors = {} } = item
  const { rows } = await query(
    `INSERT INTO live_sessions (title, description, platforms, results, errors)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [title, description, platforms, results, errors]
  )
  return rowToLive(rows[0])
}

export async function updateLive(id, updates) {
  const sets = []
  const values = []
  let i = 1

  if (updates.endedAt !== undefined) { sets.push(`ended_at = $${i++}`); values.push(updates.endedAt) }
  if (updates.status !== undefined) { sets.push(`status = $${i++}`); values.push(updates.status) }
  if (updates.results !== undefined) { sets.push(`results = $${i++}`); values.push(updates.results) }
  if (updates.errors !== undefined) { sets.push(`errors = $${i++}`); values.push(updates.errors) }
  if (!sets.length) return

  values.push(id)
  await query(`UPDATE live_sessions SET ${sets.join(', ')} WHERE id = $${i}`, values)
}
