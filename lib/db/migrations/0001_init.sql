-- Core app tables (replaces data/store.json)

CREATE TABLE users (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT,
  google_id      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE oauth_tokens (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform   TEXT NOT NULL,
  data       JSONB NOT NULL,
  saved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, platform)
);

CREATE TABLE posts (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text           TEXT NOT NULL,
  platforms      TEXT[] NOT NULL DEFAULT '{}',
  media_url      TEXT,
  results        JSONB NOT NULL DEFAULT '{}',
  errors         JSONB NOT NULL DEFAULT '{}',
  meta           JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at   TIMESTAMPTZ
);
CREATE INDEX posts_user_id_idx ON posts (user_id);
CREATE INDEX posts_created_at_idx ON posts (created_at DESC);
CREATE INDEX posts_published_at_idx ON posts (published_at DESC);

CREATE TABLE scheduled_posts (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text           TEXT NOT NULL,
  platforms      TEXT[] NOT NULL DEFAULT '{}',
  scheduled_at   TIMESTAMPTZ NOT NULL,
  image_url      TEXT,
  campaign_name  TEXT,
  video_path     TEXT,
  mime_type      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_posts_user_id_idx ON scheduled_posts (user_id);
CREATE INDEX scheduled_posts_scheduled_at_idx ON scheduled_posts (scheduled_at);

CREATE TABLE live_sessions (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          TEXT,
  description    TEXT,
  platforms      TEXT[] NOT NULL DEFAULT '{}',
  results        JSONB NOT NULL DEFAULT '{}',
  errors         JSONB NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'live',
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at       TIMESTAMPTZ
);
CREATE INDEX live_sessions_user_id_idx ON live_sessions (user_id);

-- Analytics: per-post-per-platform tracking + time-series snapshots

CREATE TABLE post_metrics (
  id             BIGSERIAL PRIMARY KEY,
  post_id        BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  platform       TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_polled_at TIMESTAMPTZ,
  polling_active BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (post_id, platform)
);
CREATE INDEX post_metrics_polling_idx ON post_metrics (polling_active, last_polled_at);

CREATE TABLE metric_snapshots (
  id                BIGSERIAL PRIMARY KEY,
  post_metric_id    BIGINT NOT NULL REFERENCES post_metrics(id) ON DELETE CASCADE,
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  likes             INTEGER,
  comments          INTEGER,
  shares            INTEGER,
  views             INTEGER,
  impressions       INTEGER,
  saves             INTEGER,
  engagement_rate   NUMERIC,
  raw               JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX metric_snapshots_post_metric_captured_idx ON metric_snapshots (post_metric_id, captured_at DESC);

CREATE TABLE analytics_insights (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  period_start   TIMESTAMPTZ NOT NULL,
  period_end     TIMESTAMPTZ NOT NULL,
  summary        TEXT NOT NULL,
  raw            JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX analytics_insights_user_generated_idx ON analytics_insights (user_id, generated_at DESC);
