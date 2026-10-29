-- App identity for the dashboard: the icon uploaded with each publish (an asset hash).
ALTER TABLE update_groups ADD COLUMN app_icon TEXT;
