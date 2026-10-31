-- Research verbeterd: mailadressen van Outscraper bewaren, trackingcode uit websites halen
-- en zaken die eerder om "geen/alleen persoonlijke adressen" of "niet bereikbaar" zijn overgeslagen opnieuw onderzoeken.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS gevonden_emails TEXT NOT NULL DEFAULT '';
UPDATE leads SET website = regexp_replace(regexp_replace(website, '(%3F|%23|\?|#).*$', '', 'i'), '/$', '')
WHERE website ~* '(%3F|%23|\?|#)';
UPDATE leads SET status = 'kandidaat', reject_reason = '', updated_at = NOW()
WHERE status = 'overgeslagen' AND sent_at IS NULL
  AND reject_reason IN ('alleen persoonlijke adressen', 'geen mailadres op de site', 'website niet bereikbaar');
