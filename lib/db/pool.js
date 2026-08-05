import pg from 'pg'

const { Pool, types } = pg

// Return bigint/numeric columns as JS numbers instead of strings — safe at this
// app's scale (ids, counts, engagement totals never approach Number.MAX_SAFE_INTEGER).
types.setTypeParser(20, val => (val === null ? null : parseInt(val, 10)))   // int8
types.setTypeParser(1700, val => (val === null ? null : parseFloat(val)))  // numeric

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — Flixty requires Postgres. See .env.example')
}

// SSL is opt-in, not opt-out: most Postgres instances this app connects to in
// practice (local dev, NexusAI's `--services postgresql` companion) don't
// support SSL at all, so defaulting to "require SSL unless told otherwise"
// broke startup against anything that wasn't the AWS RDS instance. Set
// sslmode=require in DATABASE_URL (or DATABASE_SSL=require) for a Postgres
// that does support it — Node's built-in CA bundle (Mozilla/Amazon Trust
// Services roots) validates RDS's certificate chain fine.
const wantsSsl = /sslmode=require/.test(process.env.DATABASE_URL) || process.env.DATABASE_SSL === 'require'

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: wantsSsl ? { rejectUnauthorized: true } : false,
})

export const query = (text, params) => pool.query(text, params)
