import pg from 'pg'

const { Pool, types } = pg

// Return bigint/numeric columns as JS numbers instead of strings — safe at this
// app's scale (ids, counts, engagement totals never approach Number.MAX_SAFE_INTEGER).
types.setTypeParser(20, val => (val === null ? null : parseInt(val, 10)))   // int8
types.setTypeParser(1700, val => (val === null ? null : parseFloat(val)))  // numeric

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — Flixty requires Postgres. See .env.example')
}

// Node's built-in CA bundle (Mozilla/Amazon Trust Services roots) validates RDS's
// certificate chain, so TLS verification stays on unless sslmode=disable is explicit
// (e.g. connecting to a local dev Postgres without TLS).
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('sslmode=disable') ? false : { rejectUnauthorized: true },
})

export const query = (text, params) => pool.query(text, params)
