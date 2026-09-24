-- express-session store (see lib/db/sessionStore.js) — replaces the in-memory
-- store so logins survive restarts and redeploys.
CREATE TABLE sessions (
  sid         TEXT PRIMARY KEY,
  data        JSONB NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
