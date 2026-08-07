-- A custom thumbnail image, distinct from the main video/image attachment —
-- used for YouTube's separate thumbnail-upload API (thumbnails.set) and as
-- the fallback preview image in the app's own UI for video posts that don't
-- otherwise have a still image to show.
--
-- posts.meta (JSONB) already captures arbitrary extra fields for published
-- posts, so only scheduled_posts (fixed columns) needs a new column.
ALTER TABLE scheduled_posts ADD COLUMN thumbnail_path TEXT;
