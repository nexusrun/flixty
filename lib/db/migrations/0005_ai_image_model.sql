-- Image-generation model per user (uses the same provider key/URL as text AI)

ALTER TABLE ai_settings ADD COLUMN image_model TEXT;
