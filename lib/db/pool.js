import pg from 'pg'

const { Pool, types } = pg

// Return bigint/numeric columns as JS numbers instead of strings — safe at this
// app's scale (ids, counts, engagement totals never approach Number.MAX_SAFE_INTEGER).
types.setTypeParser(20, val => (val === null ? null : parseInt(val, 10)))   // int8
types.setTypeParser(1700, val => (val === null ? null : parseFloat(val)))  // numeric

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — Flixty requires Postgres. See .env.example')
}

// SSL stays on by default (Node's built-in CA bundle validates RDS's
// certificate chain fine) — only turned off for a Postgres that explicitly
// says it doesn't support TLS, via sslmode=disable in DATABASE_URL or
// DATABASE_SSL=disable. Defaulting the other way would silently send
// credentials and data in plaintext to the RDS instance too if its
// connection string ever lacked an explicit sslmode param.
const disableSsl = /sslmode=disable/.test(process.env.DATABASE_URL) || process.env.DATABASE_SSL === 'disable'

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: disableSsl ? false : { rejectUnauthorized: true },
})

export const query = (text, params) => pool.query(text, params)
