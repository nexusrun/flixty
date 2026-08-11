-- Selected LinkedIn, Facebook, and Instagram destinations for scheduled posts.

ALTER TABLE scheduled_posts ADD COLUMN account_targets JSONB NOT NULL DEFAULT '{}';
