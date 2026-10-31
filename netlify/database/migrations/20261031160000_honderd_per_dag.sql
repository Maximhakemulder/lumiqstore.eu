-- 100 B2B-mails per werkdag en de scout op 150 zaken per dag (keuze Maxim).
UPDATE settings SET value = jsonb_set(value, '{dailyMax}', '100'), updated_at = NOW() WHERE key = 'b2b';
UPDATE settings SET value = jsonb_set(value, '{scout,perDay}', '150'), updated_at = NOW() WHERE key = 'b2b' AND value ? 'scout';
