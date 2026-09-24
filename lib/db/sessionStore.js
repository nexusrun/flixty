import session from 'express-session'
import { query } from './pool.js'

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

// Postgres-backed express-session store. The default MemoryStore loses every
// session on restart (everyone is logged out on each deploy) and never frees
// expired entries, so sessions live in the same database as everything else.
export class PgSessionStore extends session.Store {
  constructor() {
    super()
    const timer = setInterval(() => {
      query('DELETE FROM sessions WHERE expires_at < now()')
        .catch(e => console.warn('[session] prune failed:', e.message))
    }, PRUNE_INTERVAL_MS)
    timer.unref?.()
  }

  expiryFor(sess) {
    const expires = sess?.cookie?.expires
    return expires ? new Date(expires) : new Date(Date.now() + DEFAULT_TTL_MS)
  }

  get(sid, cb) {
    query('SELECT data FROM sessions WHERE sid = $1 AND expires_at > now()', [sid])
      .then(({ rows }) => cb(null, rows[0]?.data ?? null))
      .catch(cb)
  }

  set(sid, sess, cb = () => {}) {
    query(
      `INSERT INTO sessions (sid, data, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (sid) DO UPDATE SET data = $2, expires_at = $3`,
      [sid, sess, this.expiryFor(sess)]
    ).then(() => cb(null)).catch(cb)
  }

  touch(sid, sess, cb = () => {}) {
    query('UPDATE sessions SET expires_at = $2 WHERE sid = $1', [sid, this.expiryFor(sess)])
      .then(() => cb(null)).catch(cb)
  }

  destroy(sid, cb = () => {}) {
    query('DELETE FROM sessions WHERE sid = $1', [sid]).then(() => cb(null)).catch(cb)
  }
}
