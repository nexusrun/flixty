-- OAuth 2.1 authorization server for MCP clients (Claude Desktop / claude.ai
-- custom connectors). Flixty acts as its own authorization server; MCP
-- clients register dynamically, users approve via a consent screen backed by
-- their existing session login, and issued tokens map back to a user_id so
-- every MCP tool call is scoped through the same per-user store.js functions
-- the web app already uses.

CREATE TABLE mcp_clients (
  client_id       TEXT PRIMARY KEY,
  client_name     TEXT,
  redirect_uris   TEXT[] NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Short-lived (minutes), single-use authorization codes from the /authorize step.
CREATE TABLE mcp_auth_codes (
  code                  TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL REFERENCES mcp_clients(client_id) ON DELETE CASCADE,
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bearer tokens presented on every /mcp request. Hashed at rest (like
-- passwords) since they're equivalent to a credential.
CREATE TABLE mcp_access_tokens (
  token_hash   TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES mcp_clients(client_id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mcp_access_tokens_user_id_idx ON mcp_access_tokens (user_id);

CREATE TABLE mcp_refresh_tokens (
  token_hash   TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES mcp_clients(client_id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX mcp_refresh_tokens_user_id_idx ON mcp_refresh_tokens (user_id);
