-- Direct mailen (keuze Maxim): maandag t/m zaterdag, automatisch goedkeuren en de scout aan.
-- Zaken die al klaarstonden om te keuren gaan meteen in de wachtrij.
UPDATE settings SET value = jsonb_set(jsonb_set(value, '{autoGoedkeuren}', 'true'), '{sendDays}', '[1,2,3,4,5,6]'), updated_at = NOW() WHERE key = 'b2b';
UPDATE settings SET value = jsonb_set(value, '{scout,active}', 'true'), updated_at = NOW() WHERE key = 'b2b' AND value ? 'scout';
INSERT INTO settings (key, value, updated_at)
SELECT 'b2b', '{"autoGoedkeuren": true, "sendDays": [1,2,3,4,5,6], "scout": {"active": true}}'::jsonb, NOW()
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'b2b');
UPDATE leads SET status = 'goedgekeurd', updated_at = NOW() WHERE status = 'nieuw' AND email IS NOT NULL;
