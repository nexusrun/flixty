-- Per-user AI provider configuration (provider, custom base URL, API key, model)

CREATE TABLE ai_settings (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL DEFAULT 'anthropic',
  base_url   TEXT,
  api_key    TEXT,
  model      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
